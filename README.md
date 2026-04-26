# gaozhong.online 项目

## 项目结构

```
www/gaozhong.online/
├── src/                    # 源代码目录
│   ├── index.html         # 首页
│   ├── css/               # 样式文件
│   ├── js/                # JavaScript 文件
│   └── assets/            # 图片、字体等静态资源
├── dist/                  # 构建输出（自动生成）
├── deploy.sh              # 容器内部署触发脚本
├── deploy-host.sh         # 宿主机部署脚本
├── package.json           # 项目配置（如需要构建）
└── README.md              # 项目说明
```

## 快速开始

### 1. 开发网站

在 `src/` 目录下编辑你的网站文件。

### 2. 部署网站

**方式一：手动部署（推荐）**

SSH 登录服务器后执行：
```bash
bash /var/lib/openclaw/workspace/www/gaozhong.online/deploy-host.sh
```

**方式二：快捷命令（需要在宿主机配置）**

在宿主机上创建快捷命令：
```bash
sudo ln -s /var/lib/openclaw/workspace/www/gaozhong.online/deploy-host.sh /usr/local/bin/deploy-gaozhong
```

然后可以直接运行：
```bash
deploy-gaozhong
```

## 开发工作流

```
编辑代码 (workspace/www/gaozhong.online/src/)
    ↓
测试预览 (本地或临时服务器)
    ↓
执行部署 (deploy-host.sh)
    ↓
生产环境 (/var/www/gaozhong.online/)
```

## 网站访问

- 域名: http://gaozhong.online
- IP: http://111.229.116.98

## 技术栈

当前: 纯静态 HTML + Tailwind CSS (CDN)
可扩展: Vue/React + 构建工具
