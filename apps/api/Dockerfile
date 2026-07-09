FROM node:24-alpine AS build
WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY 交接文档 交接文档
RUN npm run build -w packages/shared && npm run build -w apps/api

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/apps/api apps/api
COPY --from=build /app/交接文档 交接文档
WORKDIR /app/apps/api
EXPOSE 3001
CMD ["node", "dist/main.js"]
