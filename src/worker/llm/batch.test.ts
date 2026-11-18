import { describe, expect, it } from "vitest";

import { parseBatchReply } from "./batch";

describe("parseBatchReply (rules, not a model)", () => {
  const p = (t: string, n = 4) => parseBatchReply(t, n);

  it.each(["sim", "Sim!", "s", "ok", "pode", "pode salvar", "salva", "salva tudo", "todos", "isso mesmo", "👍 sim", "confirmo"])(
    "yes: %s",
    (t) => expect(p(t)).toEqual({ kind: "all" }),
  );
  it.each(["não", "nao", "Não.", "cancela", "nenhum", "esquece", "descarta"])("no: %s", (t) => expect(p(t)).toEqual({ kind: "none" }));

  it("picks numbers in any common form", () => {
    expect(p("1,3")).toEqual({ kind: "some", indexes: [1, 3] });
    expect(p("1 e 3")).toEqual({ kind: "some", indexes: [1, 3] });
    expect(p("só o 2")).toEqual({ kind: "some", indexes: [2] });
    expect(p("salva 3, 1")).toEqual({ kind: "some", indexes: [1, 3] });
    expect(p("1 2 3 4")).toEqual({ kind: "all" });
    expect(p("todos menos 2")).toEqual({ kind: "some", indexes: [1, 3, 4] });
    expect(p("menos o 1 e o 4")).toEqual({ kind: "some", indexes: [2, 3] });
  });

  it("voice-note transcripts: punctuation and spoken numbers", () => {
    expect(p("Sim, pode salvar.")).toEqual({ kind: "all" });
    expect(p("Não, descarta.")).toEqual({ kind: "none" });
    expect(p("Um e três.")).toEqual({ kind: "some", indexes: [1, 3] });
    expect(p("Só o dois.")).toEqual({ kind: "some", indexes: [2] });
    expect(p("Todos menos o quatro.")).toEqual({ kind: "some", indexes: [1, 2, 3] });
    expect(p("Marca um café com a Ana sexta.")).toBeNull();
  });

  it("anything else is NOT an answer (handled as a normal message)", () => {
    for (const t of ["o que tenho amanhã?", "muda a 2 pra 20h", "5", "0", "1,9", "sim mas a 2 é às 20h", "dentista sexta 15h", ""]) {
      expect(p(t), t).toBeNull();
    }
  });
});
