# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace/enterprise

RUN apt-get update && \
    apt-get install --yes --no-install-recommends ca-certificates openssl && \
    rm -rf /var/lib/apt/lists/* && \
    corepack enable && \
    corepack prepare pnpm@11.9.0 --activate

COPY enterprise/package.json enterprise/pnpm-lock.yaml enterprise/pnpm-workspace.yaml enterprise/.npmrc ./
COPY enterprise/tsconfig.base.json enterprise/tsconfig.node.json enterprise/eslint.config.mjs ./
COPY enterprise/apps/api/package.json apps/api/package.json
COPY enterprise/apps/web/package.json apps/web/package.json
COPY enterprise/packages/authorization/package.json packages/authorization/package.json
COPY enterprise/packages/contracts/package.json packages/contracts/package.json
COPY enterprise/packages/database/package.json packages/database/package.json
COPY enterprise/packages/kernel-client/package.json packages/kernel-client/package.json
COPY enterprise/packages/protyle-browser/package.json packages/protyle-browser/package.json

RUN --mount=type=cache,id=singularity-pnpm,target=/pnpm/store \
    pnpm install --filter @singularity/api... --frozen-lockfile

COPY enterprise/ ./

RUN pnpm --filter @singularity/api... build && \
    pnpm --filter @singularity/api --prod deploy --legacy /opt/singularity-api

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212 AS runtime

ARG VCS_REF=unknown
ARG UPSTREAM_COMMIT=unknown

LABEL org.opencontainers.image.title="Singularity Enterprise API" \
      org.opencontainers.image.description="Singularity enterprise knowledge base control-plane API" \
      org.opencontainers.image.source="https://github.com/SparkElf/singularity" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      io.singularity.upstream.commit=$UPSTREAM_COMMIT

ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /opt/singularity-api

COPY --from=build --chown=65532:65532 /opt/singularity-api/ ./
COPY --chown=65532:65532 LICENSE NOTICE /usr/share/licenses/singularity/

USER 65532
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'3001')+'/api/v1/health/database').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["dist/main.js"]
