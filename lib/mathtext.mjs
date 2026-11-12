// 把带 LaTeX 公式的文字放进元素：$...$ 是行内公式，$$...$$ 是单独一行的公式，\$ 是普通美元符号。
// 公式用 KaTeX 转成浏览器原生的 MathML。插件里的扩展页面（工具栏弹窗、框选窗口）共用这份代码；
// 网页里的划词弹窗（content.js）不能直接引用模块，里面有一份同样规则的副本。
import katex from "./katex.mjs";

const ESCAPED_DOLLAR = "";
const MATH_RE = /\$\$([\s\S]+?)\$\$|\$(?!\s)([^$\n]+?)(?<!\s)\$/g;

// 公式的显示样式，放进页面的 <style> 里
export const MATH_CSS = `
.math { white-space: normal; }
.math math { font-family: "Cambria Math", "STIX Two Math", "Latin Modern Math", math; font-size: 1.05em; }
.math.display { display: block; margin: 4px 0; padding: 2px 0; text-align: center; overflow-x: auto; overflow-y: hidden; }
.math.display math { display: block math; }
`;

export function fillWithMath(el, text) {
  const t = String(text).replace(/\\\$/g, ESCAPED_DOLLAR);
  const plain = (s) => s.split(ESCAPED_DOLLAR).join("$");
  MATH_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = MATH_RE.exec(t))) {
    const display = m[1] != null;
    let before = t.slice(last, m.index);
    // 单独一行的公式本身就占一整行，去掉它前后的换行，免得多出空行
    if (display) before = before.replace(/[ \t]*\n[ \t]*$/, "");
    if (last > 1 && t[last - 1] === "$" && t[last - 2] === "$") before = before.replace(/^[ \t]*\n/, "");
    el.append(plain(before));
    const tex = (display ? m[1] : m[2]).split(ESCAPED_DOLLAR).join("\\$");
    const span = document.createElement("span");
    span.className = display ? "math display" : "math";
    try {
      span.innerHTML = katex.renderToString(tex, { output: "mathml", throwOnError: false, displayMode: display });
    } catch (_) {
      span.textContent = m[0]; // 渲染失败就原样显示
    }
    el.append(span);
    last = MATH_RE.lastIndex;
  }
  let tail = t.slice(last);
  if (last > 1 && t[last - 1] === "$" && t[last - 2] === "$") tail = tail.replace(/^[ \t]*\n/, "");
  el.append(plain(tail));
}
