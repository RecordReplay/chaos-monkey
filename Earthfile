FROM node:14.15.0
WORKDIR /usr/build

deps:
    COPY package.json package-lock.json ./
    RUN npm install
    SAVE ARTIFACT package-lock.json AS LOCAL ./package-lock.json

image:
    FROM +deps
    COPY client.js fuzz.js index.js logger.js utils.js .
    CMD ["node", "index.js"]
    SAVE IMAGE replay-chaos-monkey

