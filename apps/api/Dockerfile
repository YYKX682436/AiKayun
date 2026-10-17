FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/money/package.json packages/money/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @aikayun/api...
COPY packages/contracts packages/contracts
COPY packages/money packages/money
COPY apps/api apps/api
RUN pnpm --filter @aikayun/contracts build \
  && pnpm --filter @aikayun/money build \
  && pnpm --filter @aikayun/api build \
  && pnpm --filter @aikayun/api deploy --prod /prod/api

FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /var/lib/aikayun/media && chown node:node /var/lib/aikayun/media
COPY --from=build --chown=node:node /prod/api/ ./
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
