# Classes

Agency has some initial support for defining classes. Here are some things to know about.
1. You can't define your own constructors. Instead, when instantiating an object, simply pass in the attributes in the order they're defined in the class.
2. You can throw interrupts in methods.
3. You can pass blocks into methods.
4. If you instantiate an object for a class not defined in Agency, like `Set` for example, those objects will not serialize or deserialize correctly, which means you can't use them with interrupts, i.e. when you throw an interrupt the state stack cannot include a Set instance because it won't get serialized or deserialized correctly.

*Class support is still experimental.*