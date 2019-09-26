---
title: 'Serverless is not an end-all or: how to run transient EC2 instances with Lambda'
---

I've been a little despondent about some of the writings on _serverless_ making the rounds on the web recently, or perhaps perpetually. On the hype end of the train, one can find countless tutorials on building web apps around [FaaS](https://en.wikipedia.org/wiki/Function_as_a_service) offerings, that promise infinite scalability and reduced cost, but seldom delve into the reality of developing and operating such systems. Critical posts can be as short sighted, decrying the deficiencies of [trying to fit a square peg into a round hole](http://einaregilsson.com/serverless-15-percent-slower-and-eight-times-more-expensive/). Hoping to convey a more balanced take on the topic, I decided to write about how I used [AWS Lambda](https://en.wikipedia.org/wiki/AWS_Lambda) to optimise the running of periodic jobs on a recent project.

## Challenges of running periodic jobs

Periodic background jobs are a typical feature of software systems and they're used for various tasks, like data analysis or creating backups. A simple implementation might consist of configuring [crontab](http://man7.org/linux/man-pages/man5/crontab.5.html) on a single machine. While this might be sufficient for many projects, it does present some notable problems. The scheduled jobs are susceptible to single machine failure, sacrificing reliability. Efficiency is also wanting, as the compute instance has to be provisioned for the most expensive task, wasting resources while executing less demanding work or being idle.

One way to address these problems would be to manage jobs with a tool like [Kubernetes](https://kubernetes.io) or [ECS](https://aws.amazon.com/ecs/), which allow you to distribute your workload over a number of machines. Configuring and operating such a compute cluster comes with its own [overhead](https://christine.website/blog/the-cult-of-kubernetes-2019-09-07) however, which is often unreasonable, unless working on a large enough system, where the benefit outweighs the cost.

The pitch of _serverless_ compute services like Lambda is quite appealing - get all the reliability and efficiency benefits of a cluster with none of the management overhead. The reality is more complex and diving into it deserving of its own writeup. At the very least though, [the limits of Lambda](https://docs.aws.amazon.com/lambda/latest/dg/limits.html) often mean tailoring your systems implementation to it, which can incur significant development cost. This is especially true for long running and resource heavy processes, which scheduled jobs often are. While [AWS Fargate](https://aws.amazon.com/fargate/) does allow you to launch containers without needing to manage your own cluster, [it does not shield you from the complexity of ECS](https://leebriggs.co.uk/blog/2019/04/13/the-fargate-illusion.html).

## Choosing the right tool

So far I've managed to complicate the simple task of running a cron job into a DevOps nightmare. It's the situation I found myself in while working on a recent project, though to the best of my knowledge, it was no dream. At the core of this system were a set jobs, that would need to run several times a day in multiple AWS regions. The resource requirements for these processes called for using rather beefy instance types - we ended up using `m4.10xlarge`. The total running time for each invocation was rather quick however, completing in little over an hour, and their total number per day would remain in the single digits. This meant the instances would spend the majority of time burning resources while idle.

Both the penny-pincher and tree-hugger in me found this incredibly unreasonable, so I set about evaluating options for optimisation. As we were running on AWS, I turned to the suspects mentioned above - Lambda and ECS. The particular nature of these processes meant that no amount of wizardry would make them fit for Lambda, quickly ruling out that option. While digging through the ECS documentation and learning about Task Definitions and Services, it also looked like overkill for a system that would only need to run a single job.

Starting to feel overwhelmed by ECS, I started looking for a simpler solution, which led me back to Lambda. Perhaps I could just use it as a scheduler and leave the actual heavy lifting of the job to a regular old EC2 instance? Some of the [provided runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) already include the AWS SDK and being able to launch and terminate instances with it would be as simple as crafting an appropriate [IAM Role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html) and a few lines of code. The actual scheduling would be trivial with a [CloudWatch Events Rule](https://docs.aws.amazon.com/AmazonCloudWatch/latest/events/Create-CloudWatch-Events-Scheduled-Rule.html) targeting the Lambda function.

## Putting the pieces together

With that in mind, I set about creating a proof of concept. I've recreated it for the purposes of this post and will run through the process below, which can be broken down into the following steps:

- Build an EC2 image capable of running the job.
- Write a Lambda function to start a new instance with said image.
- Assign permissions to allow the above.
- Provision the infrastructure and deploy the solution.

For simplicity, I've omitted the requirement to run instances in multiple regions. Keep in mind, that the following serves as an example and is not designed to cover the requirements of a production ready implementation. Always consider the specifics of your project and design your system to account for edge cases and failures.

The code samples have been abbreviated to highlight the important parts. The full source for the example is [available on GitHub](https://github.com/martinraag/transient-ec2-with-lambda).

### Building an EC2 image

The long running job will use Python to calculate as many numbers of Pi as possible in a preconfigured amount of time and save the result to an S3 bucket. The choice of Python for this particular task might sound as reasonable as coding on a whiteboard, but we'll leave that for another time.

We'll use [Packer](https://www.packer.io) to create a new image based on Amazon Linux 2, that will include CPython and our library. You might want to consider other ways of deploying your code to the instance after the fact, as rebuilding an image for every deploy can be time consuming.

```json
{
  "builders": [
    {
      "source_ami_filter": {
        "filters": {
          "virtualization-type": "hvm",
          "name": "amzn2-ami-hvm-2.0.*-x86_64-ebs",
          "root-device-type": "ebs"
        },
        "owners": ["amazon"],
        "most_recent": true
      }
    }
  ],
  "provisioners": [
    {
      "type": "file",
      "source": "../pie",
      "destination": "/home/ec2-user"
    },
    {
      "type": "shell",
      "script": "./provision.sh"
    }
  ]
}
```

The Packed configuration file defines the `source_ami_filter`, which ensures always using the latest version of the desired base image. Figuring out the `name` can be a confusing process, but [the official documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/finding-an-ami.html) is a good place to start. The first entry in the `provisioners` section will copy our Python library to `$HOME` and the second will run the below shell script to install it and it's dependencies.

```bash
#/bin/sh

sudo yum update -y
sudo yum install python3-pip python3 python3-setuptools -y
sudo pip3 install /home/ec2-user/pie/
```

With that all set, building the image is as simple as running `packer build <configuration file>`, the output of which will include the region specific ID of the new image, or the AMI ID.

## Writing the Lambda function

The basic code required to run an EC2 instance is quite minimal.

```python
import json
import logging
import os
import time

import boto3

BUCKET = os.environ.get("BUCKET")
DURATION = os.environ.get("DURATION")
IMAGE_ID = os.environ.get("IMAGE_ID")
INSTANCE_PROFILE = os.environ.get("INSTANCE_PROFILE")
INSTANCE_TYPE = os.environ.get("INSTANCE_TYPE")
# fmt: off
USER_DATA = (
    "#!/bin/bash\n"
    f"pie {DURATION} {BUCKET}\n"
    "shutdown -h now"
)
# fmt: on

ec2 = boto3.client("ec2")
log = logging.getLogger("provision")


def run_instance(image_id, user_data, instance_type, instance_profile):
    """Run EC2 instance in given region."""

    log.info(
        f"Run instance image={image_id} type={instance_type} profile={instance_profile}"
    )
    res = ec2.run_instances(
        ImageId=image_id,
        InstanceType=instance_type,
        MinCount=1,
        MaxCount=1,
        InstanceInitiatedShutdownBehavior="terminate",
        IamInstanceProfile={"Arn": instance_profile},
        UserData=user_data,
    )
    instance_id = res["Instances"][0]["InstanceId"]
    log.info(f"Run instance success id={instance_id}")
    return instance_id


def handler(event, context):
    run_instance(IMAGE_ID, USER_DATA, INSTANCE_TYPE, INSTANCE_PROFILE)
```

The `USER_DATA` variable includes commands in the form of a shell script, that AWS will run on the instance after it starts. It uses the `pie` command installed by our Python library to start the job and instructs the system to be shut down safely after it finishes. Passing `terminate` as the `InstanceInitiatedShutdownBehavior` argument to `run_instances` assures that the instance will be automatically terminated after shut down. The combination of these instructions is how we make our instance transient. While this basic approach is all that's needed for a proof of concept, it can be error prone. A bug might cause the jobs process to run longer than expected or even indefinitely. In a production environment you might want to add additional fail-safes to make sure the instance is terminated in a timely manner.

## Assigning permissions

Writing code is just half the fun when it comes to running systems on AWS, for any of it to actually work, permissions need to be assigned. The project will need an IAM Role for both the EC2 instance and the Lambda function. I'll omit details of the former, suffice to say that the instance profile must be known to the Lambda function and explicitly referenced in the EC2 API call.

I might say figuring out the permissions to run an instance was more difficult than expected, but I have worked with AWS enough not to make foolish assumptions of ease. As ever, the process consisted of a healthy amount of Googling, playing with the [Policy Simulator](https://policysim.aws.amazon.com/) and digging through error messages. After some hair pulling I achieved a working solution, demonstrated in the snippet of [CloudFormat](https://aws.amazon.com/cloudformation/) template below.

```yaml
- PolicyName: ProvisionFunctionRunInstances
	PolicyDocument:
	Version: "2012-10-17"
	Statement:
	  - Effect: Allow
		    Action:
	      - ec2:Describe*
	      - ec2:GetConsole*
	    Resource: "*"
	  - Effect: Allow
	    Action: ec2:AssociateIamInstanceProfile
	    Resource: arn:aws:ec2:region:account:instance/*
	  - Effect: Allow
	    Action: iam:PassRole
	    Resource: !GetAtt JobInstanceRole.Arn
	  - Effect: Allow
	    Action: ec2:RunInstances
	    Resource:
	      - !Sub "arn:aws:ec2:${AWS::Region}::image/${ImageIdParam}"
	      - arn:aws:ec2:*:*:network-interface/*
	      - arn:aws:ec2:*:*:instance/*
	      - arn:aws:ec2:*:*:subnet/*
	      - arn:aws:ec2:*:*:volume/*
	      - arn:aws:ec2:*:*:key-pair/*
	      - arn:aws:ec2:*:*:security-group/*
```

Note that `JobInstanceRole.Arn` refers to the IAM Role to be assigned to the EC2 instance and the Lambda needs the `iam:PassRole` permission to do so. However the EC2 API does not require this explicitly, but rather the [Instance Profile](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-ec2_instance-profiles.html) that encapsulates it to be defined. This discrepancy is just one of the helpful ways AWS helps to keep you sharp and on your toes.

The role is limited to using only a single image with `!Sub "arn:aws:ec2:${AWS::Region}::image/${ImageIdParam}"`, which refers to the AMI ID built earlier. The rest of the statements are rather permissive and deserve a review before being used in production.

## Provisioning and deployment

As noted, I'm using CloudFormation to write the AWS infrastructure as code. While itself quite cumbersome for defining Lambda functions and its event sources, the tooling provided by the [AWS Serverless Application Model](https://github.com/awslabs/serverless-application-model) abstracts away most of that complexity and can be used by adding the section `Transform: "AWS::Serverless-2016-10-31` to the template. It enables defining _serverless_ infrastructure in a rather expressive and simple manner, as demonstrated below.

```yaml
ProvisionFunction:
	Type: AWS::Serverless::Function
	Properties:
	  Handler: provision.handler
	  Runtime: python3.7
	  CodeUri: ./lambdas
	  Timeout: 300
	  Role: !GetAtt ProvisionFunctionRole.Arn
	  Environment:
	    Variables:
	      BUCKET: !Ref ResultsBucket
	      DURATION: !Ref DurationParam
	      IMAGE_ID: !Ref ImageIdParam
	      INSTANCE_TYPE: !Ref InstanceTypeParam
	      INSTANCE_PROFILE: !GetAtt JobInstanceProfile.Arn
	  Events:
	    DailySchedule:
	      Type: Schedule
	      Properties:
	        Schedule: cron(0 23 * * ? *)
```

This defines the Lambda, associating it with the permissions described earlier and setting the environment variables required by the code. The `Events` section creates infrastructure that will trigger the function, in this case a CloudWatch Scheduled Event. The cron expression differs slightly from most implementations, but for once [the documentation](https://docs.aws.amazon.com/AmazonCloudWatch/latest/events/ScheduledEvents.html) is straightforward and short.

The deployment process is all but automated by the [AWS CLI](https://aws.amazon.com/cli/) and consists of running the `aws cloudformation package` and `aws cloudformation deploy` commands. Once complete, the infrastructure will have been provisioned and code deployed. The Lambda function will be executed according to the schedule, in turn running the EC2 instance that executes the desired job. Once the process completes, the virtual machine is terminated.

## Summary

The example shows how to leverage AWS Lambda to improve the reliability and efficiency of running periodic jobs. It removes the possibility of a single-machine failure impeding future processes from being launched, by relying on CloudWatch as a scheduler. It allows choosing an instance type suitable for the job, avoiding over-provisioning. By terminating the virtual machine after the work is complete, the risk of running idle resources is reduced.

It proved to be a reliable approach for the project I was working on, but it is not applicable to every system. It doesn't intend to be. Instead, what I hoped to show is that _serverless_ tools, like AWS Lambda, are just that - tools. They can be a useful utility to when applied correctly and a hindrance when misused.

The full source code for the example project is [available on Github](https://github.com/martinraag/transient-ec2-with-lambda).
