// REF https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/eval
export const looseJsonParse = (text: string) => {
    return Function(`"use strict";return (${text})`)();
};
