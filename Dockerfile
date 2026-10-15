FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY data ./data
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/data ./data
# Root keeps /data writable when a Fly or Railway volume is mounted over it.
RUN mkdir -p /data
ENV GROKSHOP_DATA_DIR=/data
ENV PORT=8080
ENV GROKSHOP_HTTP_HOST=0.0.0.0
ENV GROKSHOP_PUBLIC_URL=https://YOUR_HOST
ENV GROKSHOP_SHIPPING_MODE=stub
ENV GROKSHOP_PAYMENTS_MODE=stub
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/remote.js"]
