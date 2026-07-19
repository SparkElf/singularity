# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS node-build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace/enterprise

RUN apt-get update && \
    apt-get install --yes --no-install-recommends ca-certificates openssl && \
    rm -rf /var/lib/apt/lists/* && \
    corepack enable && \
    corepack prepare pnpm@11.9.0 --activate

COPY enterprise/package.json enterprise/pnpm-lock.yaml enterprise/pnpm-workspace.yaml enterprise/.npmrc enterprise/.pnpmfile.cjs ./
COPY enterprise/tsconfig.base.json enterprise/tsconfig.node.json enterprise/eslint.config.mjs ./
COPY enterprise/apps/worker/package.json apps/worker/package.json
COPY enterprise/packages/authorization/package.json packages/authorization/package.json
COPY enterprise/packages/contracts/package.json packages/contracts/package.json
COPY enterprise/packages/database/package.json packages/database/package.json
COPY enterprise/packages/kernel-client/package.json packages/kernel-client/package.json
COPY enterprise/packages/object-store/package.json packages/object-store/package.json

RUN --mount=type=cache,id=singularity-pnpm,target=/pnpm/store \
    pnpm install --filter @singularity/worker... --frozen-lockfile

COPY enterprise/ ./

RUN pnpm --filter @singularity/worker... build && \
    pnpm --filter @singularity/worker --prod deploy /opt/singularity-worker && \
    pnpm --dir /opt/singularity-worker pkg delete devDependencies && \
    rm -f \
      /opt/singularity-worker/pnpm-lock.yaml \
      /opt/singularity-worker/pnpm-workspace.yaml \
      /opt/singularity-worker/node_modules/.pnpm-workspace-state-v1.json && \
    mkdir -p \
      /opt/singularity-runtime/home \
      /opt/singularity-runtime/objects \
      /opt/singularity-runtime/runtime && \
    touch \
      /opt/singularity-runtime/objects/.keep \
      /opt/singularity-runtime/runtime/.keep

FROM golang:1.26-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651 AS kernel-build

WORKDIR /kernel
COPY kernel/go.mod kernel/go.sum ./

RUN --mount=type=cache,id=singularity-go-build,target=/root/.cache/go-build \
    --mount=type=cache,id=singularity-go-mod,target=/go/pkg/mod \
    go mod download

COPY kernel/ ./

RUN --mount=type=cache,id=singularity-go-build,target=/root/.cache/go-build \
    --mount=type=cache,id=singularity-go-mod,target=/go/pkg/mod \
    CGO_ENABLED=1 go build -tags "fts5 sqlcipher" -ldflags "-s -w" -o /kernel/kernel .

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212 AS runtime

ARG VCS_REF=unknown
ARG UPSTREAM_COMMIT=unknown

LABEL org.opencontainers.image.title="Singularity Enterprise Worker" \
      org.opencontainers.image.description="Singularity enterprise knowledge base background worker" \
      org.opencontainers.image.source="https://github.com/SparkElf/singularity" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      io.singularity.upstream.commit=$UPSTREAM_COMMIT

ENV NODE_ENV=production
ENV HOME=/var/lib/singularity-worker/home
ENV SINGULARITY_WORKER_OBJECT_STORE_ROOT=/var/lib/singularity-worker/objects
ENV SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL=/opt/singularity-kernel/kernel
ENV SINGULARITY_WORKER_RESTORE_KERNEL_BINARY=/opt/singularity-kernel/kernel
ENV SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY=/opt/singularity-kernel
ENV SINGULARITY_WORKER_RESTORE_RUNTIME_ROOT=/var/lib/singularity-worker/runtime

WORKDIR /opt/singularity-worker

COPY --from=node-build --chown=65532:65532 /opt/singularity-worker/ ./
COPY --from=node-build --chown=65532:65532 /opt/singularity-runtime/ /var/lib/singularity-worker/
COPY --from=kernel-build --chown=65532:65532 --chmod=755 /kernel/kernel /opt/singularity-kernel/kernel
COPY --chown=65532:65532 app/appearance/ /opt/singularity-kernel/appearance/
COPY --chown=65532:65532 LICENSE NOTICE /usr/share/licenses/singularity/

USER 65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const fs=require('node:fs'),path=require('node:path');try{process.kill(1,0);if(process.versions.node.split('.')[0]!=='24')throw new Error();for(const file of [process.env.SINGULARITY_WORKER_RESTORE_ARCHIVE_TOOL,process.env.SINGULARITY_WORKER_RESTORE_KERNEL_BINARY])fs.accessSync(file,fs.constants.X_OK);fs.accessSync(path.join(process.env.SINGULARITY_WORKER_RESTORE_KERNEL_WORKING_DIRECTORY,'appearance','langs','en.json'),fs.constants.R_OK)}catch{process.exit(1)}"]

CMD ["dist/main.js"]
