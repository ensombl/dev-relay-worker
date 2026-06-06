FROM node:24-alpine AS build
WORKDIR /usr/src/app

RUN corepack enable && corepack prepare pnpm@11.3.0 --activate

COPY package.json pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --ignore-scripts; else pnpm install --ignore-scripts; fi

COPY tsconfig.json ./
COPY src src

RUN pnpm build
RUN pnpm prune --prod --ignore-scripts

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY --from=build /usr/src/app/node_modules node_modules
COPY --from=build /usr/src/app/package.json package.json
COPY --from=build /usr/src/app/dist dist

USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
