# Publicar una versión

Forja se publica como `@jhayro1/forja` (los nombres `forja` y `forja-cli` ya existen en npm).

## Una sola vez

1. Confirma que el scope `@jhayro1` existe en npm y es tuyo: `npm access list packages @jhayro1` (con tu sesión de npm).
2. Crea un token de automatización en npmjs.com (Access Tokens → Generate → Automation).
3. En GitHub: Settings → Environments → crea el entorno `npm` y agrega el secreto `NPM_TOKEN`.
   El entorno permite exigir una aprobación manual antes de cada publicación.

## Cada versión

```bash
npm version 0.2.0 --no-git-tag-version   # o patch/minor/major
git commit -am "versión 0.2.0"
git tag v0.2.0 && git push && git push --tags
```

El flujo `publicar` comprueba que la etiqueta coincide con `package.json`, corre lint, typecheck,
pruebas (con el sandbox real) y la instalación limpia del paquete, y publica con
`npm publish --provenance`: npm muestra que el paquete se construyó desde este repositorio y
este commit.
