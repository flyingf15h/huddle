FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=7777
EXPOSE 7777
VOLUME /data
CMD ["node", "src/cli.js", "server", "--data", "/data", "--project", "default"]
