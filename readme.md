# Acode Language Server
 
 Express websocket application for thw acode language servers plugin.
 
 
## Running locally


To setup and run this plugin locally:

- Clone this repo (`git clone https://github.com/7HR4IZ3/acode-language-server`)
- Change directory (`cd acode-language-server`)
- Run `npm install`
- Start server (`node server.mjs`)


## Contributing


Users can also add other language servers and send a pull request so they are
added to the plugin.

For an example on how to do so, check out the `html`, `typescript` and `svelte`
serverMode examples in `server.js`.

You can also use the `python` mode as an example on how to setup a websocket
proxy if the target language server can only be started as a websocket server.

An example of a stdin and stdout language server would be added in future.

