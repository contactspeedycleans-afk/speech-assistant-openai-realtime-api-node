FROM mcr.microsoft.com/playwright:v1.54.0-noble

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

CMD ["node", "playwright/octopus-notification-watcher.js"]
