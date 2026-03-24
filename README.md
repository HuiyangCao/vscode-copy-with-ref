# 一键配置 PyCharm 风格

一个 VS Code 插件，一键配置 PyCharm 风格的开发环境：Darcula 主题、JetBrains Mono 字体、文件树优化、快捷键绑定、文件引用复制等。

## 安装

```bash
bash ./install.sh   # 不要 sudo
```

自动安装到 VS Code；如果检测到 Cursor 也会同时安装。

## 功能一览

### 1. 文件树与编辑器优化

插件自动配置更符合直觉的文件树和编辑器行为(主要是方便选择文件和文件夹时不会打开一堆)：

- **双击展开文件夹** — 单击不再意外展开目录树
- **双击打开文件** — 避免选择文件误开大量标签页
- **固定标签页独立一行** — 固定的标签页与普通标签页分开显示，不会被挤掉

### 2. 复制文件名

在资源管理器中右键文件 → **Copy File Name**，将文件名（不含路径）复制到剪贴板。

### 3. 复制文件到系统剪贴板

在资源管理器中右键选中文件 → **Copy to System Clipboard**，以 GNOME 文件管理器格式写入系统剪贴板，可直接在文件管理器中粘贴。

> 依赖 `xclip`，如未安装请执行：`sudo apt install xclip`

### 4. 复制文件引用

选中代码（或仅放置光标），按 `Ctrl+Shift+C`，或右键菜单 → **Copy with File Reference**。

**选中多行：**
```
@src/mjlab/tasks/tracking/config/walk_env_cfg.py:28-29
```

**仅光标：**
```
@src/mjlab/tasks/tracking/config/walk_env_cfg.py:28
```

路径相对于工作区根目录，复制后状态栏会短暂提示。适合粘贴到终端、AI 对话、Issue 等场景。

### 5. 快速定位文件夹

按 `Ctrl+Alt+E` 弹出文件夹搜索列表，选中后在资源管理器中展开对应目录。

### 7. 自动设置 PyCharm 风格

插件激活时自动应用以下全局设置：

| 设置项 | 值 |
|--------|----|
| 主题 | JetBrains Darcula Theme |
| 字体 | JetBrains Mono, 14px |
| 字体连字 | 启用 |

字体设置覆盖：编辑器、终端、调试控制台、Notebook、Chat、Markdown 预览、GitLens 等所有区域。

**首次激活时**，如果未安装 Darcula 主题或 JetBrains Mono 字体，插件会弹窗提示：
- 主题：点击提示可跳转到扩展商店搜索 **JetBrains Darcula Theme**
- 字体：Ubuntu 用户可执行 `sudo apt install fonts-jetbrains-mono`，或访问 [JetBrains Mono 官方下载页](https://www.jetbrains.com/lp/mono/#how-to-install)

### 8. 自定义配置与快捷键

插件激活时自动写入用户配置（`settings.json`）和快捷键（`keybindings.json`），只增和改，不删除用户手动添加的内容。

如需自定义，修改 [`src/extension.ts`](src/extension.ts) 中的以下两处后重新编译即可：
- **快捷键**：`CUSTOM_KEYBINDINGS` 数组（约第 10-37 行）
- **用户配置**：`applySettings` 函数（约第 85-121 行）
