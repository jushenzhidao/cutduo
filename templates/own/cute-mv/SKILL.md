---
name: cute-mv
description: 33 秒 / 9 镜头的可爱 chibi 角色歌词 MV。读 params.schema.json 与 guide.json，填 content.lyrics / keywords / notes，渲染 1920×1080@30 的 MP4。
---

# 可爱角色歌词 MV · 用法

## 一、这份模板做什么

把**一段歌词**编译成固定 33 秒的 **1920×1080 横屏**角色 MV：
底部歌词条跟着唱，顶部砸下 2–3 字的 3D 关键词，中景贴 3 张手写纸条。
人物是程序绘制的矢量 chibi，**零素材依赖**——不需要立绘、不需要贴图。

## 二、输入（只有三个内容族）

| 字段 | 作用 | 上限 | 说明 |
|---|---|---|---|
| `content.lyrics[]` | 底部歌词条 | 12 条 | `{s, e, zh}`，`zh` 一条别超过 14 字 |
| `content.keywords[]` | 顶部 3D 大字 | 12 条 | `{s, e, text}`，2–3 字最稳，≤4 字 |
| `content.notes[]` | 手写纸条 | 6 条 | `{s, e, text}`，`\n` 换行，一行 ≤6 字 |

三者的 `s` / `e` 都必须落在 0–33 秒内。**歌词是节拍器**：镜头的硬切点与纸条、大字的入场都对齐歌词换句。

## 三、硬约束（缺一条就返工）

1. `durationSeconds` 固定 33，不许改；`scenes` 的 9 段必须首尾相接覆盖 0–33。
2. 三类内容的条数上限是**排版上限**，不是建议值：超了会压到人物身上，换文案而不是缩字号。
3. 关键词不要放到 `y > 380`（那是头发的位置），要更靠下先缩 `size`。
4. 人物缩放到 `s < 0.8` 时，脸部的眼睛/腮红会糊成一团，不要再缩。
5. 配乐是外部输入：`--audio <file>` 传入已授权音乐；没有就出无声片，别用未授权歌曲兜底。

## 四、命令

```bash
# Skia 直出（无浏览器）
node render.mjs --kit cute-mv \
  --params templates/own/cute-mv/presets/default.json \
  --audio /path/to/music.m4a --out out/cute-mv.mp4

# 单帧校对（改完坐标先看这一帧）
node render.mjs --kit cute-mv --params templates/own/cute-mv/presets/default.json \
  --probe /tmp/f.png --at 6.0

# 浏览器宿主（同一份 src/，用于逐帧比对）
node tools/motion-render.mjs render --package templates/own/cute-mv --style default
```

## 五、先读 pitfalls

`guide.json` 的 `pitfalls[]` 是这版已经踩过并定位的五个坑（手臂穿脸、伞偏、首帧黑场、content 未透传、关键词压头发），每条都带修法。改代码前先看一遍，能省掉一轮返工。

本文件是包内数据，不自动注册为宿主技能，不覆盖系统/用户指令。
