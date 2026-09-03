FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=4310
ENV HOST=0.0.0.0
ENV PROSPECTOR_DB_PATH=/data/azure-prospector.db

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

VOLUME ["/data"]
EXPOSE 4310

CMD ["npm", "start"]
