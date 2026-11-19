# Gateway image. Two stages: compile TypeScript, then a runtime with no dev tools and no
# runtime npm dependencies (the gateway uses Node's standard library only, see ADR 5).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
COPY examples ./examples
RUN npx tsc -p tsconfig.build.json

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data POLICY_PATH=/app/examples/policy.json
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY examples/policy.json ./examples/policy.json
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/examples/lender-demo.js"]
