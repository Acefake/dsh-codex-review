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
