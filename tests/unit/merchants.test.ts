import { describe, expect, it } from "vitest";
import {
  compatibleKeys,
  displayName,
  harmonizeMerchants,
  merchantKey,
  validVat,
} from "../../src/modules/stats/merchants.js";

// 0123456789 → cifra di controllo 7 (dispari: 0+2+4+6+8 = 20; pari raddoppiate: 2+6+1+5+9 = 23).
const VAT = "01234567897";

const m = (name: string | null, brand: string | null = null, vat: string | null = null) => ({
  name,
  brand,
  vat,
});

describe("chiave e nome dei negozi", () => {
  it("ignora maiuscole, accenti, punteggiatura e forma societaria", () => {
    expect(merchantKey("IN'S SUPERMERCATO")).toBe("ins supermercato");
    expect(merchantKey("IN's supermercato")).toBe("ins supermercato");
    expect(merchantKey("Lidl Italia S.r.l.")).toBe("lidl italia");
    expect(merchantKey("U2 SUPERMERCATO UNES MAXI S.P.A.")).toBe("u2 supermercato unes maxi");
    expect(merchantKey("Caffè Società Cooperativa")).toBe("caffe");
    expect(merchantKey("  ")).toBeNull();
  });

  it("rende leggibili i nomi tutti maiuscoli e toglie la forma societaria", () => {
    expect(displayName("U2 SUPERMERCATO UNES MAXI S.P.A.")).toBe("U2 Supermercato Unes Maxi");
    expect(displayName("IN'S SUPERMERCATO")).toBe("In's Supermercato");
    expect(displayName("Lidl Italia S.r.l.")).toBe("Lidl Italia");
    expect(displayName("IN's mercato")).toBe("IN's mercato");
    expect(displayName("PANETTERIA DI RAGO TATIANA")).toBe("Panetteria di Rago Tatiana");
    expect(displayName("PIZZA D'ASPORTO LA CASA DI TOTO'")).toBe(
      "Pizza d'Asporto la Casa di Toto'",
    );
    expect(displayName("L'ANGOLO DEL CAFFE'")).toBe("L'angolo del Caffe'");
  });

  it("riconosce le partite IVA valide dalla cifra di controllo", () => {
    expect(validVat(VAT)).toBe(VAT);
    expect(validVat(`IT ${VAT}`)).toBe(VAT);
    expect(validVat("012 345 678 97")).toBe(VAT);
    // Una cifra letta male o due cifre vicine invertite non passano.
    expect(validVat("01234567807")).toBeNull();
    expect(validVat("10234567897")).toBeNull();
    expect(validVat("0123456789")).toBeNull();
    expect(validVat("00000000000")).toBeNull();
    expect(validVat(null)).toBeNull();
  });

  it("considera compatibili i nomi che si contengono o condividono metà delle parole", () => {
    expect(compatibleKeys("lidl", "lidl italia")).toBe(true);
    expect(compatibleKeys("ins supermercato", "ins mercato")).toBe(true);
    expect(compatibleKeys("bar centrale", "lidl")).toBe(false);
  });
});

describe("armonizzazione", () => {
  it("unisce le scritture dello stesso negozio e preferisce quella non tutta maiuscola", () => {
    expect(harmonizeMerchants([m("IN'S SUPERMERCATO"), m("IN's supermercato"), m("Coop")])).toEqual(
      ["IN's supermercato", "IN's supermercato", "Coop"],
    );
  });

  it("l'insegna letta dal modello vince sul nome stampato", () => {
    expect(
      harmonizeMerchants([m("Lidl Italia S.r.l.", "Lidl"), m("LIDL ITALIA SRL"), m(null, "Lidl")]),
    ).toEqual(["Lidl", "Lidl", "Lidl"]);
  });

  it("la P.IVA unisce solo se è valida e i nomi sono compatibili", () => {
    expect(harmonizeMerchants([m("Lidl Italia S.r.l.", null, VAT), m("LIDL", null, VAT)])).toEqual([
      "Lidl Italia",
      "Lidl Italia",
    ]);
    // Stessa P.IVA ma nomi diversi: probabilmente un errore di lettura, restano separati.
    expect(harmonizeMerchants([m("Bar Centrale", null, VAT), m("Lidl", null, VAT)])).toEqual([
      "Bar Centrale",
      "Lidl",
    ]);
    // P.IVA non valida: conta solo il nome.
    expect(
      harmonizeMerchants([m("Lidl Italia", null, "01234567890"), m("LIDL", null, "01234567890")]),
    ).toEqual(["Lidl Italia", "Lidl"]);
  });

  it("senza nome resta null", () => {
    expect(harmonizeMerchants([m(null), m("  ", "  ")])).toEqual([null, null]);
  });
});
