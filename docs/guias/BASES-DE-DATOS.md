# Bases de datos

Forja puede usar tu base de datos de pruebas (MySQL/MariaDB o PostgreSQL) mientras planea y
programa, con reglas que tú controlas. **La clave nunca llega a un agente**: Forja se conecta
por su cuenta y ejecuta sólo lo que las reglas permiten.

## Las reglas

| Qué quiere hacer el agente | Qué pasa |
|---|---|
| Ver el esquema (tablas y columnas) | Libre, sin preguntar |
| Consultar datos (SELECT, SHOW…) | Tú eliges por proyecto: **con tu aprobación** o **sin preguntar**. Siempre en solo lectura y hasta 200 filas |
| Crear una tabla | Solicitud con **por qué** y **para qué**; se ejecuta sólo si la apruebas |
| Cambiar o borrar datos, alterar o borrar una tabla **creada por Forja** | Igual: solicitud con motivo y tu aprobación |
| Cambiar o borrar una tabla **que ya existía** | **Imposible.** Forja lo bloquea antes de llegar a la base, aunque lo apruebes |

**Registro por proyecto.** Forja anota cada tabla que crea: quién la creó, cuándo y con qué
solicitud. Son las únicas que se pueden modificar. Lo ves en **Conexiones → Tablas creadas
por Forja** o con `forja bd tablas`.

**Varias barreras.** Además de esas reglas:

- **Qué se acepta:** una sentencia por solicitud, sin comentarios, y sólo las formas
  permitidas. Nada de vistas, procedimientos, disparadores, permisos, otras bases, CASCADE ni
  renombrados.
- **Las lecturas** corren en una transacción de solo lectura que siempre se deshace.
- **Antes de ejecutar**, Forja vuelve a revisar las reglas.

Por si acaso, usa para esto un usuario de base de datos con permisos limitados a tu base de
pruebas.

## Registrar la conexión desde el panel (lo más fácil)

1. **Conexiones → Bases de datos → Nueva conexión.**
2. En «Pega lo que tengas», pega tu URL (`jdbc:mysql://host:3306/base?…`) **o el bloque de
   variables** que ya usas, por ejemplo:
   ```
   APP_URL_VENTAS: jdbc:mysql://172.16.0.10:3306/ventas?useSSL=false
   APP_URL_DEVVENTAS: jdbc:mysql://172.16.0.10:3306/devventas?useSSL=false
   APP_DBUSER: usuario_app
   APP_DBPASSWORD: ••••••
   ```
3. Pulsa **Completar el formulario con esto**. Forja rellena:
   - el servidor y el puerto;
   - las bases (`ventas`, `devventas`);
   - el usuario y la clave;
   - las **variables para las pruebas**.
4. **Probar conexión** (se conecta a cada base) y **Guardar**. La clave y las variables quedan
   cifradas en tu PC.
5. **Usar aquí.** Eliges:
   - qué bases usa este proyecto;
   - si las lecturas piden tu aprobación;
   - si las variables pasan a las pruebas del proyecto.

## Lo mismo por terminal

```sh
# Guarda tus variables en un archivo (por ejemplo variables.txt) y:
forja bd nueva pruebas --desde-archivo variables.txt
forja bd probar pruebas
forja bd usar pruebas --bases devventas --lectura preguntar --pruebas

# O por partes (la clave se pide sin eco, nunca como argumento):
forja bd nueva pruebas --url "jdbc:mysql://172.16.0.10:3306/devventas" --usuario usuario_app --con-clave

forja bd ver pruebas                     # qué alcanza: bases del servidor, tablas, filas aprox. y tamaño
forja bd ver pruebas --columnas --contar # + columnas con PK/FK y filas exactas
forja bd esquema pruebas --base devventas
forja bd contexto                        # lo que ve el planeador en este proyecto (--completo: el bloque exacto)
forja bd solicitudes            # lo que pidieron los agentes
forja bd aprobar bdq_…          # aprueba y ejecuta
forja bd rechazar bdq_… "usa la tabla de pagos que ya existe"
forja bd tablas                 # tablas creadas por Forja
```

## Comprobar que se ve todo

Antes de planear, en este orden:

1. **`forja bd probar <nombre>`**: se conecta a cada base y muestra la versión del servidor.
2. **`forja bd ver <nombre>`**: no necesita proyecto y no lee filas. Muestra:
   - las bases que el usuario ve en el servidor (con `*` las configuradas);
   - las tablas y vistas de cada base, con filas aproximadas, tamaño y comentario.

   Opciones:
   - `--columnas`: añade las columnas, con sus claves primarias (PK) y foráneas (→).
   - `--contar`: cuenta las filas exactas con `COUNT(*)`.

   Si falta una tabla, casi siempre es un permiso del usuario de la base.
3. **`forja bd contexto`** (dentro del proyecto): muestra lo que recibe el planeador en
   descubrir, especificar y dividir. Por cada base dice cuántas tablas y claves foráneas
   llegan, si se recortó por tamaño y si sólo llega un error. Con `--completo` imprime el
   bloque tal cual.

Todo esto lee sólo el catálogo de la base, en una transacción de solo lectura que se deshace.
No modifica nada.

## Qué ven los agentes y el planeador

**El planeador** recibe la estructura de las bases vinculadas, sin datos: tablas, columnas
con tipo, claves primarias y foráneas. Lo recibe en el descubrimiento, al especificar y al
dividir en tareas. Usa las tablas reales, no pregunta lo que el esquema ya muestra y, si hace
falta guardar algo nuevo, propone una tabla nueva en vez de cambiar las que existen. Si una
base no responde, recibe el error y te avisa en vez de suponer su contenido.

**Los agentes** tienen estas herramientas:

| Herramienta | Para qué |
|---|---|
| `bd_listar` | Ver qué bases están vinculadas |
| `bd_esquema` | Ver tablas y columnas |
| `bd_consultar` | Hacer una consulta de lectura |
| `bd_solicitar_cambio` | Pedir un cambio, explicando por qué y para qué |
| `bd_estado` | Ver cómo va su solicitud y su resultado |

Cuando una solicitud espera tu aprobación, aparece en **Te necesita** (tablero) y en
**Conexiones**. El agente sigue con lo que no dependa de ella.

## Variables para las pruebas

Si activas «Pasar las variables a las pruebas», los comandos de prueba del proyecto
(`npm test`, `mvn test`…) reciben tus variables, por ejemplo `APP_URL_…` y `APP_DBPASSWORD`.
Nunca van escritas en disco en la orden del comando y sus valores se tachan de los registros.

Ojo: **el código de las pruebas lo escriben los agentes**. Con esta opción ese código puede
usar la clave, así que actívala sólo con una base de pruebas.

En **Forja Completa** los comandos de prueba corren sin red dentro del sandbox, así que no
alcanzan la base. Esta opción está pensada para **Forja Ligera**.
