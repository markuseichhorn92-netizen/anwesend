# Amazon Bedrock: EU-Verarbeitung und Nullspeicherung

## Kontoeinstellung verifizieren

In `eu-central-1` mit einem dafür berechtigten Administrationskonto:

```powershell
aws bedrock put-account-data-retention --mode none --region eu-central-1
aws bedrock get-account-data-retention --region eu-central-1
```

Der zweite Befehl muss `none` ausgeben. Den datierten Nachweis in der Datenschutzakte speichern. Falls das verwendete Mantle-Projekt eine eigene Einstellung besitzt, auch dort `none` setzen und verifizieren.

## Guardrail

Der Prompt-Injection- und Datenabfluss-Schutz ist in [prompt-injection-guardrail.md](./prompt-injection-guardrail.md) beschrieben.

[`zero-retention-guardrail.json`](./zero-retention-guardrail.json) enthält zwei explizite Deny-Regeln. In einer AWS Organization als SCP eingesetzt verhindert sie, dass Konten oder Mantle-Projekte auf einen anderen Aufbewahrungsmodus gestellt werden. Bei einem Einzelkonto muss dieselbe Bedingung in einer ausreichend hoch priorisierten Organisations-/Berechtigungsgrenze durchgesetzt werden; eine Richtlinie nur an der Vercel-Laufzeitrolle schützt nicht vor Administratoränderungen.

Die Vercel-Rolle selbst erhält **keine** Retention-Verwaltungsrechte, sondern nur `bedrock:InvokeModel` und `bedrock:InvokeModelWithResponseStream` für das tatsächlich verwendete EU-Inferenzprofil sowie die darin enthaltenen Modellressourcen. Modell-/Profil-ARNs müssen aus dem AWS-Konto übernommen werden; keine globale Wildcard verwenden.

## Region technisch erzwingen

- `AWS_REGION=eu-central-1`
- `BEDROCK_MODEL_ID` muss die ID oder ARN des EU-Inferenzprofils sein, nicht die reine Foundation-Model-ID.
- IAM-Bedingung `aws:RequestedRegion` auf die freigegebenen EU-Regionen begrenzen.
- Bei regionsübergreifendem EU-Profil müssen alle vom Profil verwendeten EU-Foundation-Model-ARNs in der IAM-Richtlinie erlaubt sein.

Quelle: [AWS Bedrock data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html)

