FROM node:20-alpine

# 安装 Docker 客户端及 Docker Compose 插件，以便在容器内调用宿主机 Docker 命令
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app/manager

# 拷贝依赖配置文件并安装
COPY package*.json ./
RUN npm install --production

# 拷贝服务代码
COPY . .

EXPOSE 9988

CMD ["node", "server.js"]
