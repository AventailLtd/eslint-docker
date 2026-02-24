# alpine ban nincs bash.
# https://hub.docker.com/_/node 2026-02-24
FROM node:24.13.1

ADD package.json /package.json
ADD eslint-local-rules /eslint-local-rules
WORKDIR /app
RUN yarn install
