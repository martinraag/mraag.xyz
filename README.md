# mraag.xyz

My personal website and blog, available at [mraag.xyz](https://mraag.xyz).

## About

The project generates a static website with [Eleventy](https://www.11ty.io). The documents are
styled with [tailwindcss](https://tailwindcss.com). Static assets include illustrations from
[absurd.design](https://absurd.design) and icons from [Feather](https://feathericons.com).

## Development

Building the project depends on [Node.js](https://nodejs.org) and [Yarn](https://yarnpkg.com).

### Install dependencies

```
yarn
```

### Create configuration

The project is configured with a set of environment variables. In a development environment they can
be specified with a `.env` file.

```
cat > .env <<EOF
NODE_ENV=development
MR_GA_ID=<google analytics id>
MR_EMAIL=<contact email>
MR_GITHUB_URL=<github profile url>
MR_LINKEDINI_URL=<linkedin profile url>
MR_TWITTER_URL=<twitter profile url>
MR_INSTAGRAM_URL=<instagram profile url>
EOF
```

### Start development server

Runs a local development server and watches files for changes, triggering a rebuild.

```
yarn start
```

## Build and deploy

For production builds, the `NODE_ENV` environment variable must be set to `production`.

```
yarn build
```

The static assets will be generated in the `dist` directory and can be deployed to any host
capable of serving HTTP requests.

The project includes a [configuration file](./netlify.toml) for deployment to
[Netlify](https://www.netlify.com), which configures security and cache headers for the site.
