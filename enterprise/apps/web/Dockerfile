# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace/enterprise

RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

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
    pnpm install --filter @singularity/web... --frozen-lockfile

COPY enterprise/ ./

RUN pnpm --filter @singularity/web build

FROM nginxinc/nginx-unprivileged:1.29.4-alpine@sha256:a6c4f61f456b85b8fdf7ec7ab28cc3e299440e6fb4a9dea520e5fd8fd440025e AS runtime

ARG VCS_REF=unknown
ARG UPSTREAM_COMMIT=unknown

LABEL org.opencontainers.image.title="Singularity Enterprise Web" \
      org.opencontainers.image.description="Singularity enterprise knowledge base web application" \
      org.opencontainers.image.source="https://github.com/SparkElf/singularity" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      io.singularity.upstream.commit=$UPSTREAM_COMMIT

COPY enterprise/apps/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /workspace/enterprise/apps/web/dist/ /usr/share/nginx/html/
COPY LICENSE NOTICE /usr/share/licenses/singularity/

USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "-", "http://127.0.0.1:8080/healthz"]
