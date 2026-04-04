token-data-dashboard部署指南

## 服务器信息

- 地址: devuser@10.4.181.124
- 密码: 请联系管理员获取

## 自动化部署（推荐）

### 首次使用：配置 SSH Key（仅一次）

```bash
./tool/setup-ssh.sh
```

执行后按提示输入一次服务器密码，之后即可免密登录。

### 日常部署

```bash
./tool/deploy.sh
```

脚本会自动完成：拉取最新代码 -> 启动服务。

## 手动部署

1. 通过ssh连接到服务器
   devuser@10.4.181.124
2. cd ~/codeup/token-data-dashboard
3. git pull origin main
4. ./start.sh
