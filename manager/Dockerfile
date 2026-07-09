FROM node:20-alpine

# 安装 Docker 客户端、Docker Compose 插件及 git（build 型容器「更新」需要 git pull）
RUN apk add --no-cache docker-cli docker-cli-compose git

WORKDIR /app/manager

# 拷贝依赖配置文件并安装
COPY package*.json ./
RUN npm install --production

# 拷贝服务代码
COPY . .

EXPOSE 9988

CMD ["node", "server.js"]
