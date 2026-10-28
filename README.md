# dsh-codex-review

DSH 代码审查组合包：GitHub PR 工作台、AI 审查、评论与发布。

## 安装

仓库根目录和 `plugin/` 都是有效的 DSH 组合包入口。根目录声明 `dsh.bundle.patch` 与 `dsh.client`，支持从 Git 地址、克隆后的仓库目录或根目录打出的 npm tarball 安装。

在 DSH 插件管理器中，安装来源可填写：

```text
git+https://github.com/Acefake/dsh-codex-review.git
```

本地目录安装可选择本仓库根目录；原来指向 `plugin/` 的安装方式也继续支持。两个入口的包名相同，不要在同一 profile 中重复安装。

如果先前安装报“这个包没有声明组合包”，更新到包含根目录 `package.json` 的版本后，重新选择该 Git 来源或目录安装。已经安装的副本也需要更新，单独刷新页面不会更新包元数据。

根目录打包：

```sh
npm pack
```

详细功能、宿主生效方式与配置见 [插件说明](plugin/README.md)。

## 开发机同步（避免安装副本被旧版本覆盖）

DSH 插件管理器可能按 `github:Acefake/dsh-codex-review` 的旧提交重装，把 profile 里的安装副本降级（表现为界面报“列表加载失败，宿主返回非 JSON 响应”）。在仓库根目录运行：

```sh
npm run sync:install -- --url http://127.0.0.1:<当前 GUI 端口>
```

脚本会：

1. 把 `package.json`、`README.md`、`plugin/**` 复制到 `~/.dsh/profiles/<profile>/node_modules/dsh-codex-review`；
2. 校验安装后的版本与根包一致、关键文件存在；
3. 若宿主报告的版本落后（或传 `--force-reload`），切换一次 profile patch 的真实配置值触发重载；
4. 校验 `/codex-review/health` 与 `/codex-review/accounts` 返回 JSON。

常用参数：`--profile work`（其他 profile）、`--target <dir>`（自定义安装目录）、`--dry-run`（只看路径/版本）、`--no-reload`（只同步）。
