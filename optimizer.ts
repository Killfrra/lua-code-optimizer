//jshint asi: true
//jshint esversion: 8
import { promises as fs } from 'fs'
import * as parser from 'luaparse'
import {
    Node, Chunk,
    IfStatement, IfClause, ElseifClause, ElseClause,
    WhileStatement, DoStatement, RepeatStatement,
    AssignmentStatement, LocalStatement, FunctionDeclaration,
    ForNumericStatement, ForGenericStatement,
    Identifier,
} from 'luaparse'
// @ts-ignore
import luamin from 'luamin'

type Conditional =
IfStatement | //IfClause | ElseifClause | ElseClause |
WhileStatement | DoStatement | RepeatStatement |
ForNumericStatement | ForGenericStatement

type Block = Chunk | Conditional | FunctionDeclaration

type Assigner =
AssignmentStatement | LocalStatement | FunctionDeclaration |
ForNumericStatement | ForGenericStatement

type VarValue = Node | undefined | null

class LastAccess {
    readonly value: VarValue
    readonly value_used: number
    readonly assigner?: Assigner
    readonly accessor: Identifier
    constructor(v: Var, accessor: Identifier){
        this.value = v.value
        this.value_used = v.value_used
        this.assigner = v.assigner
        this.accessor = accessor
    }
}

class Var {
    name: string
    value: VarValue
    value_used = 0
    assigner?: Assigner

    // На случай, если значение не будет востребовано до выхода из условного блока
    //TODO: do ... end имеет блок, но не является оператором ветвления
    opt_candidates: Var[] = []

    constructor(name: string, value: VarValue, assigner?: Assigner){
        this.name = name
        this.set(value, assigner)
    }

    set(value?: VarValue, assigner?: Assigner){
        this.value = value
        this.value_used = 0
        this.assigner = assigner
    }

    last_access?: LastAccess
    get(accessor: Identifier){
        this.value_used++
        this.last_access = new LastAccess(this, accessor)
        this.opt_candidates = []
    }

    static is_global(name: string){
        //return !/^[LA]\d+_(?!1$)\d+$/.test(name)
        return !/^[LA]\d+_\d+$/.test(name)
    }
}

type VarDict = { [key: string]: Var }

let mode = 1
let log = (...args: any[]) => {
    if(mode === 0){
        console.log.apply(null, args)
    }
}

let to_replace = new Map<Identifier, Node>()
let to_remove = new Set<Node>()
function post_process(node: Node){
    for(let [ key, child ] of Object.entries(node)) {
        if(child === null || typeof child !== 'object'){
            continue
        }
        if(typeof child.type === 'string'){
            if(child.type === 'Identifier'){
                let replacement = to_replace.get(child)
                if(replacement){
                    child = replacement
                }
            }
            post_process(child);
            (node as any)[key] = child
            continue
        }
        if(Array.isArray(child)){
            let res: Node[] = []
            for(let sub of child){
                if(to_remove.has(sub)){
                    continue
                }
                if(sub.type === 'Identifier'){
                    let replacement = to_replace.get(sub)
                    if(replacement){
                        sub = replacement
                    }
                }
                post_process(sub)
                res.push(sub)
            }
            (node as any)[key] = res
        }
    }
}

class Scope {
    static last_id = 0
    id: number
    block: Block
    vars: VarDict = {}
    background_vars: VarDict = {}
    parent_scope?: Scope
    isolate = true
    constructor(block: Block, parent_scope?: Scope){
        this.id = Scope.last_id++
        log(this.id, 'constructor')
        this.block = block
        this.parent_scope = parent_scope
    }
    get(id: Identifier){
        let v = this.vars[id.name] || this.background_vars[id.name]
        if(v){
            v.get(id)
            log(this.id, 'get', id.name, v.value_used)
        } else {
            this.parent_scope?.get(id)
        }
    }
    denull(value: Node | null): Node {
        if(value === null){
            return { type: 'NilLiteral', value: null, raw: 'nil' }
        }
        return value
    }
    //TODO: don't remove calls
    remove(assigner: Assigner|undefined, name: string){
        if(!assigner){
            return
        } else if(
            assigner.type === 'FunctionDeclaration' || (
                assigner.type === 'AssignmentStatement' &&
                assigner.variables.length === 1
            )
        ){
            log('remove', assigner)
            /*
            delete (assigner as any).type;
            delete (assigner as any).name;
            //*/to_remove.add(assigner)
        } /* else if(assigner.type === 'LocalStatement'){
            if(assigner.variables.length === 1){
                log('remove local', name, 'from', assigner)
                assigner.variables = []
                assigner.init = []
                to_remove.add(assigner)
            } else if(
                assigner.init.length === 0 ||
                assigner.init.length >= assigner.variables.length
            ){
                let vi = assigner.variables.findIndex(v => v.name === name)
                log('remove local', name, 'from', assigner, 'at', vi)
                assigner.variables.splice(vi, 1)
                if(vi < assigner.init.length){
                    assigner.init.slice(vi, 1)
                }
            }
        }*/
    }
    replace(id: Identifier, node: Node){
        //node = node.type === 'Identifier' && to_replace.get(node) || node //HACK: obviously
        log('replace', id.name, '->', node)
        /*
        delete (id as any).type
        delete (id as any).name
        Object.assign(id, node)
        //*/
        to_replace.set(id, node)
    }
    opt(v: Var, sid: number){
        //log(sid, 'opt', v)
        //TODO: Если за пределами текущей функции
        // и текущая функция вызывает какую-то другую функцию,
        // которая читает или может читать это значение.
        // Т.е. вызов функции помечает все значения
        // за пределами текущей функции как читаемые? (помечает внутри функции?)
        // Или помечает текущий условный блок как содержащий вызов внешней функции?
        if(Var.is_global(v.name)){
            return
        }
        if(v.value_used == 0){
            //TODO: track declaration and remove
            //TODO: deduplicate
            if(v.last_access && v.last_access.value_used == 1 && v.last_access.value !== undefined){
                this.replace(v.last_access.accessor, this.denull(v.last_access.value))
                this.remove(v.last_access.assigner, v.name)
                v.last_access = undefined
            }
            for(let candidate of v.opt_candidates){
                this.opt(candidate, sid)
            }
            this.remove(v.assigner, v.name)
            v.assigner = undefined
            v.value_used = 0
        } else if(
            v.last_access &&
            v.last_access.value === v.value &&
            v.last_access.assigner === v.assigner &&
            v.last_access.value_used === v.value_used
        ){
            if(v.last_access && v.last_access.value_used === 1 && v.last_access.value !== undefined){
                this.replace(v.last_access.accessor, this.denull(v.last_access.value))
                this.remove(v.last_access.assigner, v.name)
                v.last_access = undefined
                v.assigner = undefined
                v.value_used = 0
                /*
                for(let candidate of v.opt_candidates){
                    this.opt(candidate, sid)
                }
                */
            }
        }
    }
    set(id: Identifier, value: Node|undefined, assigner: Assigner){
        log(this.id, 'set', id.name)
        let v = this.vars[id.name] || this.background_vars[id.name]
        if(v){
            this.opt(v, this.id)
            v.set(value, assigner)
        } else {
            v = this.background_vars[id.name] = new Var(id.name, value, assigner)
        }
    }
    declare(id: Identifier, value: Node|null|undefined, assigner: Assigner){
        let v = this.vars[id.name]
        if(v){
            log(this.id, 'redeclare', id.name)
            this.opt(v, this.id)
            v.set(value, assigner)
        } else {
            log(this.id, 'declare', id.name)
            v = this.vars[id.name] = new Var(id.name, value, assigner)
        }
    }
    setUndefined(name: string, opt_candidates: Var[], opt_candidate?: Var){
        log(this.id, 'setUndefined', name, opt_candidates, opt_candidate)
        let v = this.vars[name] || this.background_vars[name]
        if(v){

        } else {
            v = this.background_vars[name] = new Var(name, undefined, undefined)
        }

        v.opt_candidates.push(...opt_candidates)
        if(opt_candidate && opt_candidate.value_used <= 1){
            v.opt_candidates.push(opt_candidate)
        }

        //TODO:
        if(v.value_used <= 1){
            let tv = new Var(v.name, v.value, v.assigner)
            tv.last_access = v.last_access
            tv.value_used = v.value_used
            v.opt_candidates.push(tv)
        }

        v.set(undefined, undefined)
    }
    destroy(){
        log(this.id, 'destroy')
        for(let [k, v] of Object.entries(this.vars)){
            this.opt(v, this.id)
        }
        if(this.parent_scope){
            for(let [k, v] of Object.entries(this.background_vars)){
                this.parent_scope.setUndefined(k, v.opt_candidates, v)
            }
        }
    }
}

function walk(node: Node, scope: Scope, fn: (node: Node, scope: Scope) => undefined|false){
    if (fn(node, scope) === false) return

    for(let [ key, child ] of Object.entries(node)) {
        if (child === null || typeof child !== 'object'){
            continue
        }
        if (typeof child.type === 'string'){
            walk(child, scope, fn)
            continue
        }
        let sub_scope = scope
        if(key === 'body'){ //TODO: fix any
            sub_scope = new Scope(node as any, scope)
        }
        if (Array.isArray(child)) {
            for(let sub of child) {
                walk(sub, sub_scope, fn)
            }
        }
        if(sub_scope != scope){
            sub_scope.destroy()
        }
    }
}

function fn(node: Node, scope: Scope){
    if(node.type === 'IfStatement'){
        let sub_scopes = []
        for(let clause of node.clauses){
            if('condition' in clause){
                walk(clause.condition, scope, fn)
            }
            let sub_scope = new Scope(node, scope)
            sub_scopes.push(sub_scope)
            for(let sub of clause.body){
                walk(sub, sub_scope, fn)
            }
        }
        for(let sub_scope of sub_scopes){
            sub_scope.destroy()
        }
        return false
    } else if(node.type === 'LocalStatement'){
        for(let child of node.init){
            walk(child, scope, fn)
        }
        for(let child of node.variables){
            scope.declare(child, null, node)
        }
        return false
    } else if(node.type === 'FunctionDeclaration'){
        if(node.identifier && node.identifier.type === 'Identifier'){
            //TODO: Что если фукнция обратится к себе по имени?
            scope.declare(node.identifier, node, node)
        }
        let sub_scope = new Scope(node, scope)
        for(let child of node.parameters){
            if(child.type === 'Identifier'){
                sub_scope.declare(child, child, node)
            }
        }
        for(let child of node.body){
            walk(child, sub_scope, fn)
        }
        sub_scope.destroy()
        return false
    } else if(node.type === 'ForNumericStatement'){
        walk(node.start, scope, fn)
        walk(node.end, scope, fn)
        if(node.step){
            walk(node.step, scope, fn)
        }
        let sub_scope = new Scope(node, scope)
        sub_scope.declare(node.variable, node.variable, node)
        for(let child of node.body){
            walk(child, sub_scope, fn)
        }
        sub_scope.destroy()
        return false
    } else if(node.type === 'ForGenericStatement'){
        for(let child of node.iterators){
            walk(child, scope, fn)
        }
        let sub_scope = new Scope(node, scope)
        for(let child of node.variables){
            sub_scope.declare(child, child, node)
        }
        for(let child of node.body){
            walk(child, sub_scope, fn)
        }
        sub_scope.destroy()
        return false
    } else if(node.type === 'AssignmentStatement'){
        for(let child of node.variables){
            if(child.type === 'IndexExpression'){
                walk(child.base, scope, fn)
                walk(child.index, scope, fn)
            } else if(child.type === 'MemberExpression'){
                walk(child.base, scope, fn)
            }
        }
        for(let child of node.init){
            walk(child, scope, fn)
        }
        if(
            node.variables.length === 1 &&
            node.init.length === 1 &&
            node.variables[0].type === 'Identifier' &&
            true //Var.is_local(node.variables[0].name) //TODO:
        ){
            scope.set(node.variables[0], node.init[0], node)
        } else {
            for(let child of node.variables){
                if(child.type === 'Identifier'){
                    scope.set(child, undefined, node)
                }
            }
        }
        return false
    } else if(node.type === 'Identifier'){
        scope.get(node)
        return false
    }
}

let argv2 = process.argv[2]
let argv3 = process.argv[3]
mode = argv3 ? parseInt(argv3) : mode
let path = argv2 || 'BBBase.min.lua'
let script: string = await fs.readFile(path, 'utf8')
let ast = parser.parse(script, {
    scope: true,
    luaVersion: "5.2"
})
ast = JSON.parse(JSON.stringify(ast))
let g = new Scope(ast)
walk(ast, g, fn)

let changed: boolean
do {
    changed = false
    for(let [k, v] of [...to_replace.entries()]){
        if(v.type === 'Identifier'){
            let t = to_replace.get(v)
            if(t){
                to_replace.set(k, t)
                changed = true
            }
        }
    }
} while(changed)

post_process(ast)
if(mode === 1){
    script = luamin.minify(ast)
    script = script.replace(/\b(then|do|else)\b|\bfunction\b.*?\(.*?\)/g, '$&\n')
    console.log(script)
} else if(mode === 2){
    console.log(JSON.stringify(ast))
}