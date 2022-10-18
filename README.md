# lua-code-optimizer
Aggressive (but not very yet) Lua code optimizer. Created to improve the readability of code obtained from unluac by decompiling luaobj files

# Installation and usage
```bash
git clone https://github.com/Killfrra/lua-code-optimizer
cd lua-code-optimizer
npm install
node optimizer.js input.lua > output.lua
```
After that, the code will have to be formatted with something else

# Notes
Uses luaparse to build the parse tree and luamin to convert back to a string.
Includes a couple of fixes that disable checks for proper placement of goto statements and labels and suppress unsupported type errors