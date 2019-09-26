---
title: Running transient servers with serverless
---

It would seem to me like the writings on _serverless_ making rounds on the web recently are quite polarising. On the one hand there are countless tutorials on building web apps around [FaaS](https://en.wikipedia.org/wiki/Function_as_a_service) offerings, that promise infinite scalability and reduced cost, but seldom delve into the reality of developing and operating such systems. Critical posts too can be short sighted, decrying the deficiencies of [trying to fit a square peg into a round hole](http://einaregilsson.com/serverless-15-percent-slower-and-eight-times-more-expensive/). In my experience _serverless_ tools are not an all-or-nothing proposition. To demonstrate this, I decided to write about a real world example of using [AWS Lambda](https://en.wikipedia.org/wiki/AWS_Lambda) to optimise running periodic jobs on EC2 instances.

## Challenges of running periodic jobs

Periodic jobs are used for various tasks, like data analysis, log processing or creating backups. A simple implementation might use [crontab](http://man7.org/linux/man-pages/man5/crontab.5.html) to schedule processes on a single \*nix machine. This can be sufficient for many projects, but the approach does present some notable problems. Server failures are inevitable, if the one instance is not running, neither are the jobs configured on it. Resources like CPU, memory and bandwidth have to be provisioned with the most expensive task in mind, which is wasteful when executing less demanding work. So there's room for improving reliability and efficiency.

A popular way to address these problems is to run applications as containers using a tool like [Kubernetes](https://kubernetes.io) or [ECS](https://aws.amazon.com/ecs/), which distribute the workload over a number of machines. However, the [overhead](https://christine.website/blog/the-cult-of-kubernetes-2019-09-07) of configuring and operating such compute clusters can be unreasonable, unless the size of the system is large enough for the benefits to outweigh the costs.

The pitch of _serverless_ compute services is quite appealing - get the reliability and efficiency benefits of a cluster without the management overhead. The reality is more complex and diving into it deserving of its own writeup. At the very least though, [the limits of Lambda](https://docs.aws.amazon.com/lambda/latest/dg/limits.html) often mean tailoring your systems implementation to it, which can incur significant development cost. [Fargate](https://aws.amazon.com/fargate/) is more flexible, allowing you to run containers without a dedicated cluster, but [it does not shield you from the complexity of ECS](https://leebriggs.co.uk/blog/2019/04/13/the-fargate-illusion.html).

## Choosing the right tool

I found myself evaluating these options while working on a system deployed to AWS. At its core were a set of jobs running several times a day in multiple regions. Their requirements meant using rather beefy instance types, but the total running time of each invocation would barely exceed an hour. This meant the servers would spend the majority of their time burning resources while idle.

The particular nature of these processes meant that no amount of wizardry would make them fit for Lambda, quickly ruling out that option. While digging through the ECS documentation and learning about Task Definitions and Services, it also looked like overkill for a system that would only need to run a single job.

Looking for a simpler solution led me back to Lambda. Perhaps I could just use it as a scheduler and leave the actual heavy lifting of the job to regular old EC2 instances? Some of the [provided runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) already include the AWS SDK and being able to launch and terminate instances with it would be a matter of crafting an appropriate [IAM Role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html) and a few lines of code. The actual scheduling would be trivial with a [CloudWatch Events Rule](https://docs.aws.amazon.com/AmazonCloudWatch/latest/events/Create-CloudWatch-Events-Scheduled-Rule.html) targeting the Lambda function.

## Putting the pieces together

With that in mind, I set about creating a proof of concept. I've recreated it for the purposes of this post and will run through the process below, which can be broken down into the following steps:

- Build an EC2 image capable of running the job.
- Write a Lambda function to start a new instance with said image.
- Assign permissions to allow the above.
- Provision the infrastructure and deploy the solution.

For simplicity, I've omitted the requirement to run instances in multiple regions. Keep in mind, that the following serves as an example and is not designed to cover the requirements of a production ready implementation. Always consider the specifics of your project and design your system to account for edge cases and failures.

The code samples have been abbreviated to highlight the important parts. The full source for the example is [available on GitHub](https://github.com/martinraag/transient-ec2-with-lambda).

### Building an EC2 image

The long running job will use Python to calculate as many numbers of Pi as possible in a preconfigured amount of time and save the result to an S3 bucket. The choice of Python for this particular task might sound as reasonable as coding on a whiteboard, but I'll leave that for another for another time.

I used [Packer](https://www.packer.io) to create a new image based on Amazon Linux 2, including CPython and our library. You might want to consider other ways of deploying your code to the instance after the fact, as rebuilding an image for every deploy can be time consuming.

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

The Packer configuration file defines a `source_ami_filter`, ensuring the build uses the latest version of the desired base image. Figuring out the `name` can be a confusing process, but [the official documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/finding-an-ami.html) is a good place to start. The first entry in the `provisioners` section will copy our Python library to the `$HOME` directory and the second will run the below shell script to install it and it's dependencies.

```bash
#/bin/sh

sudo yum update -y
sudo yum install python3-pip python3 python3-setuptools -y
sudo pip3 install /home/ec2-user/pie/
```

With that set, building an image is as simple as running `packer build <configuration file>`, the output of which will include the region specific ID of the new image, or the AMI ID.

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

The `USER_DATA` variable includes commands in the form of a shell script, that AWS will run on the instance after it starts. It uses the `pie` command installed by our Python library to start the job and instructs the system to be shut down safely after it finishes. Passing `terminate` as the `InstanceInitiatedShutdownBehavior` argument to `run_instances` assures that the instance will be automatically terminated after shut down. The combination of these instructions is how we make our instance transient. While this basic approach is all that's needed for a proof of concept, it can be error prone. A bug might cause the job's process to run longer than expected or even indefinitely. In a production environment you might want to add additional fail-safes to make sure the instance is terminated in a timely manner.

## Assigning permissions

Writing code is just half the fun when it comes to running systems on AWS, for any of it to actually work, permissions need to be assigned. The project needs roles for both the EC2 instance and the Lambda function. I'll omit details of the former, suffice to say that it must be known to the Lambda function and explicitly referenced in the EC2 API call.

I might say figuring out the permissions to run an instance was more difficult than expected, but I have worked with AWS enough not to make foolish assumptions of ease. As ever, the process consisted of a healthy amount of Googling, playing with the [Policy Simulator](https://policysim.aws.amazon.com/) and digging through error messages. The hair pulling led me to a policy demonstrated in the snippet of [CloudFormat](https://aws.amazon.com/cloudformation/) template below.

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

Note that `JobInstanceRole.Arn` refers to the IAM Role to be assigned to the EC2 instance and the Lambda needs the `iam:PassRole` permission to do so. However the EC2 API does not accept this role explicitly, but rather an [Instance Profile](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-ec2_instance-profiles.html) that encapsulates it. This discrepancy is just one of the helpful ways AWS helps to keep you sharp and on your toes.

The permissions limit running an instance with only a single image, the one built earlier. The rest of the statements are rather permissive and deserve a review before being used in production.

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

The deployment process is all but automated by the [AWS CLI](https://aws.amazon.com/cli/) and consists of running a couple of shell commands. Once complete, the infrastructure will have been provisioned and code deployed. The Lambda function will be executed according to the schedule, in turn running the EC2 instance that executes the desired job. Once the process completes, the virtual machine is terminated.

## Summary

The example shows how to leverage AWS Lambda to improve the reliability and efficiency of running periodic jobs. It removes the possibility of a single-machine failure impeding future processes from being launched, by relying on CloudWatch as a scheduler. It allows choosing an instance type suitable for the job, avoiding over-provisioning. By terminating the virtual machine after the work is complete, the risk of running idle resources is reduced.

It proved to be a reliable approach for the project I was working on, but it is not applicable to every system. Then again, it doesn't intend to be. Instead, what I hoped to show is that _serverless_ tools, like AWS Lambda, are just that - tools. They can be a useful utility to when applied correctly and a hindrance when misused.

The full source code for the example project is [available on Github](https://github.com/martinraag/transient-ec2-with-lambda).
