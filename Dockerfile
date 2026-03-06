ARG NODE_VERSION=24


FROM node:${NODE_VERSION} AS build
ENV NODE_ENV=development
WORKDIR /opt/build
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN node --run build


FROM node:${NODE_VERSION} AS deps
ENV NODE_ENV=production
WORKDIR /opt/deps
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && mkdir -p node_modules


FROM node:${NODE_VERSION}-slim AS app
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /opt/app

COPY package.json pnpm-lock.yaml ./
COPY --from=deps /opt/deps/node_modules ./node_modules
COPY --from=build /opt/build/dist ./dist

USER node:node
EXPOSE 3000
CMD ["node", "--run", "start"]
