# The batch-job image visitors launch on Fargate. Built by CodeBuild (see
# buildspec.yml) — there is deliberately no Docker on the dev machine.
# public.ecr.aws mirror instead of Docker Hub: anonymous Hub pulls from
# CodeBuild's shared IPs hit rate limits.
FROM public.ecr.aws/docker/library/node:22-alpine

WORKDIR /job
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

COPY src ./src

# Run unprivileged; the task definition also mounts the root fs read-only.
USER node

CMD ["node", "src/run.mjs"]
