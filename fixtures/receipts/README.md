# Scontrini di prova

Metti qui 10–20 scontrini reali (jpg, png, webp, pdf) per provare l'estrazione:

```sh
pnpm simulate:upload fixtures/receipts
```

I file non sono nel repository: contengono dati personali (esercenti, importi, a volte nomi e
codici fiscali). Prima di committarne qualcuno, oscura i dati sensibili.
I test automatici non li usano: lavorano con file sintetici e un modello finto.
