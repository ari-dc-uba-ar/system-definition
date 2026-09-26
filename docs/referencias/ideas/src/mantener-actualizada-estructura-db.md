# ¿Cómo mantenera actualizada la estructura de la base de datos?

## el problema

Cuando un sistema ya está instalado y hacemos alguna modificación en el código
que necesita una modificación en la base de datos
(por ejemplo una columna pasa a ser not null o cambia el tipo de text a integer)
tenemos que actualizar la definición en el código fuente
e ir a cambiar (cuando instalemos una nueva versión que incluya esa modficación)
la estructura de la base.

Podemos tener varias instancias de ese código funcionando
(ambiente de producción, testing, capacitación o distintas sucursales o proyectos).

Aún cuando el framewok nos genere los scripts de creación de la base de datos
es difícil generar automáticamente scripts de modificación de la estructura
(savo para los casos más simples).
Además porque no solo es el cambio de tipos
sino la decisión de cómo convertir los datos para que quepan en la nueva estructura.

Probablemente terminemos escribiendo scripts de actualización
de la estructura de la base de datos que corremos con algún grado de automatización,
pero del que no tenemos garantías de que produzca el cambio preciso.

## el deseo

Que el framework nos ayude.

## el contexto

Partamos de la base de que tenemos un framework como [backend-plus]
que nos permite escribir dentro del código fuente del programa
la estructura completa de la base de datos (definiciones de tablas, claves
primarias y foráneas, restricciones, etc)
y generar el script de creación de la base de datos a partir de esos datos.

## la idea

Para el desarrollador continuar con lo que venimos haciendo:
  1. Generar toda la estructura dentro del framework:
     1. tablas, claves, restricciones, vistas
     2. carga de metadatos (datos que deban estar almacenados en
        determinadas tablas para que el programa funcione)
     3. procedimientos almacenados
  2. Escribir los scripts de actualización de una versión a otra.
     1. Tiene que haber una manera de nombrar las versiones
     2. Debe poder ejecutarse varios scripts para actualizar una
        versión más vieja que la anterior.

Que el framework nos ayude de la siguiente manera:
  1. Al instalar o actualizar una instalación guarde
     en forma canónica (o sea en alguna forma y orden determinísticos)
     la estructura generada.
  2. Cuando se trate de una actualización que **verifique**
     que a partir de la instalación anterior se puede llegar a la nueva
     corriendo los scripts de actualización. Que **advierta si no**.

### verificación automática

La verificación podría realizarse con los siguientes pasos:
  1. Se genera un dump de creación de la base de datos en cada instalación
     (sabemos que el dump de creación de nuestro programa
     no es igual al dump volcado por la base de datos, porque puede tener
     cuestiones sintácticas distintas)
  2. En una instancia de base de datos especial en blanco
     se genera la base con el script de la última instalación
     y se vuelca el dump de la base
  3. Se aplican luego los scripts de actualización sobre esa base
     y se genera un nuevo dump de la base
  4. Se comparan ambos dumps
     (cuando usemos pg_dump tenemos que preprocesar ambos dumps porque
     no hay garantías de orden [1])
  5. Si todo está bien se puede intentar correr los scripts de actualización
     sobre la base de datos con datos reales
  6. En caso del sistema en producción habría primero que
     probar los scripts de actualización sobre un backup.
     **Recordar que si hay cambios en los datos no alcanza con
     pobar en una base en blanco**

### marcar las versiones durante el desarrollo

La verificación automática no solo debe hacerse al instalar la versión
también hay que ir haciendo **verificaciones automáticas durante el desarrollo**.

Para eso hay que marcar (con un tag) ciertos commits como "versiones instalables"
y utilizar esos tags para ir haciendo las verificaciones automáticas.


[backend-plus]: https://github.com/codenautas/backend-plus
[1]: https://stackoverflow.com/a/2179304/5203271
