# Single-image production build: frontend compiled, backend serves everything.
FROM node:24-alpine AS fe
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app/backend
COPY backend/package.json ./
RUN npm install --no-audit --no-fund
COPY backend/ ./
COPY --from=fe /app/frontend/dist /app/frontend/dist

ENV PORT=4000
EXPOSE 4000
CMD ["npx", "tsx", "src/index.ts"]
