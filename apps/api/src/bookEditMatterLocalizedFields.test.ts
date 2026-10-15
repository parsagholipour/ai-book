import { describe, expect, it } from "vitest";

import { mentionsBookMatter } from "./bookEditMatter.js";

describe("routing requests that use translated matter labels", () => {
  it.each([
    "添加保留所有权利声明",
    "権利留保の表示を追加してください",
    "Füge den Rechtevorbehalt hinzu",
    "권리 보유 문구를 삭제해 주세요",
    "Удали строку об охране прав",
    "Haklar saklıdır satırını kaldır",
    "Supprime mon site web",
    "Remova meu site",
    "出版方改为晨星",
    "حقوق کے مالک کو علی رضا کریں",
    "Rimuovi la pagina L’autore"
  ])("recognizes %j as matter", (message) => {
    expect(mentionsBookMatter(message)).toBe(true);
  });

  it.each([
    "Réécris le chapitre 2 pour parler de mon site web",
    "Reescreva o capítulo 2 sobre meu site",
    "Riscrivi il capitolo 2 in cui l’autore passeggia",
    "Ändere den Dialog im Kapitel 2 über den Rechtevorbehalt",
    "Добавь диалог о строке об охране прав в главе 2",
    "Décris le site archéologique",
    "Descreva o site arqueológico",
    "Que dit mon site web ?",
    "権利留保の表示とは何ですか？"
  ])("keeps prose or questions out of matter for %j", (message) => {
    expect(mentionsBookMatter(message)).toBe(false);
  });
});
