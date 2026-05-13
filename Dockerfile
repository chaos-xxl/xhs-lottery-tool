FROM node:20-slim

# 安装 Chrome 依赖
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto-cjk \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Playwright 使用系统 Chromium
ENV CHROME_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# 安装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 复制源码
COPY . .

# 构建
RUN npm run build

# 初始化数据库
RUN npm run db:migrate

EXPOSE 3000

# 启动（绑定 0.0.0.0 让 Docker 外部可访问）
CMD ["npm", "start"]
