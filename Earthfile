FROM node:14.15.0
WORKDIR /usr/src

deps:
    COPY package.json package-lock.json ./
    RUN npm install
    SAVE ARTIFACT package-lock.json AS LOCAL ./package-lock.json

src:
    COPY client.js fuzz.js index.js logger.js utils.js .
    SAVE ARTIFACT ./

image:
    FROM +deps
    CMD ["node", "index.js"]
    COPY +src/* .
    SAVE IMAGE replay-chaos-monkey