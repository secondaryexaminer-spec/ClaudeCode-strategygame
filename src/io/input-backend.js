'use strict';
// 输入后端（InputBackend）：把某种输入源的原始事件，翻译成画布像素坐标。
//
// 【和 io/storage.js 是同一类东西】
// storage.js 抽象"数据存哪"，这里抽象"输入从哪来"。两者都只提供一层薄薄的
// 翻译，把平台相关的部分收在一处，让上面的模块不必知道下面是浏览器、触屏
// 还是一段回放脚本。
//
// 【为什么值得抽出来】
// 这段换算原来在 ui/input.js 里**重复了三次**（点击、缩放、拖拽各一份）：
//
//     const rect = canvas.getBoundingClientRect();
//     const sx = (event.clientX - rect.left) * canvas.width / rect.width;
//
// 三份手抄的代码迟早会分叉 —— 改其中一处忘了另外两处，表现是"点击准了但缩放
// 中心偏了"这种极难定位的错。
//
// 【分界线】
// 这里只懂"事件 → 画布像素"。画布像素 → 格子坐标是 ui/input.js 的事（它要读
// cam / zoom / S），世界坐标的夹取是 render/board.js 的事。三层各管一段。

// 浏览器鼠标事件后端。
//
// getCanvas 传函数而不是 canvas 本身：canvas 元素在 main.js 装配时就存在，
// 但它的 width/height 会随窗口变化，每次都得重新读。
export function createDomInputBackend(getCanvas) {
  // canvas 的 CSS 尺寸和它的像素尺寸可以不一样（响应式布局会拉伸它），
  // 所以要按 width/rect.width 换算回像素。少这一步，缩放后点击就会偏。
  function measure() {
    const canvas = getCanvas();
    const rect = canvas.getBoundingClientRect();
    return {
      rect,
      sx: rect.width ? canvas.width / rect.width : 1,
      sy: rect.height ? canvas.height / rect.height : 1
    };
  }

  return {
    kind: 'dom',
    // 事件发生在画布的哪个像素上。
    at(event) {
      const { rect, sx, sy } = measure();
      return {
        x: (event.clientX - rect.left) * sx,
        y: (event.clientY - rect.top) * sy
      };
    },
    // 一段 CSS 像素位移对应多少画布像素位移（右键拖拽平移用）。
    //
    // ⚠️ 两个方向都乘 x 方向的比例（sx），这是**照搬原有行为**，不是笔误。
    // 原来的 panBy 就是 `const scale = canvas.width / rect.width` 然后同时用于
    // dx 和 dy。画布非等比拉伸时纵向拖拽会偏，看着像 bug —— 但修它会改变行为，
    // 属于另一件事，不该混在这次抽象里顺手做掉。要修请单独一次提交，并确认
    // 交互链里的拖拽断言仍然通过。
    delta(dxCss, dyCss) {
      const { sx } = measure();
      return { dx: dxCss * sx, dy: dyCss * sx };
    }
  };
}
