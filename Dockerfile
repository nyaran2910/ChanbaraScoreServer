FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir data && chown node:node data
USER node
EXPOSE 3080
EXPOSE 42044/udp
CMD ["node", "src/index.mjs"]
