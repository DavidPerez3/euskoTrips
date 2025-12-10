FROM node:20-alpine
WORKDIR /usr/src/app

# solo copia package.json
COPY package.json ./
# sin lockfile -> npm install
RUN npm install --omit=dev

COPY src ./src

ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/app.js"]
