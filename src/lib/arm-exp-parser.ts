//
// arm-parser-expressions.ts - ARM Parser 
// Class to parse ARM template expressions, e.g. stuff inside square brackets []
// Ben Coleman, 2019
//

import * as _ from 'lodash';

import * as utils from './utils';
import { Template } from './arm-parser-types';
import * as fs from 'fs';
import * as flat from 'flat';
const uuidv5 = require('uuid/v5');

export default class ARMExpressionParser {
  template: Template;
  cache: any;
  secondPass: boolean;

  // We store the template to save use passing it millions of times
  constructor(t: Template) {
    this.template = t;
    this.cache = {};
    this.secondPass = false;
  }

  public eval(exp: string, check = false): any {
    // TODO: Make sure that non string values are never passed in the first place
    if(typeof(exp) !== 'string') return exp;

    // Speedup using dynamic programming
    if(this.cache[exp]) {
      // Dont cache pending_refernce in second pass
      if(!(this.secondPass && this.cache[exp].startsWith('['))){
        const evalResult = this.cache[exp];
        // Dont cache unresolved as it might be resolved later
        // TODO: Find a more elegant way of doing this
        if(typeof(evalResult) === 'string' && evalResult.indexOf('{') === -1){
          return this.cache[exp];
        }
      }
    }
    
    // Eval all the way to the bottom
    let lastEvalResult = this.evalHelper(exp,check);
    this.cache[exp] = lastEvalResult;
    
    let evalResult = '';
    while(lastEvalResult !== evalResult) {
      evalResult = this.evalHelper(lastEvalResult,check);
      this.cache[lastEvalResult] = evalResult;
      lastEvalResult = evalResult;
    }

    return evalResult;
  }

  private funcCallWithPropertyExtractor(exp: string): any{
    // Remove surrounding [] if present
    const matches = exp.match(/\[(.*)\](.*)/);

    // TODO: Have a proper CFG parser
    const splitInThree = (str: string): string[] => {
      // return str.match(/(\w+)\((.*)\)((?:\.|\[).*)/);
      const openIndex = str.indexOf('(');
      let closeIndex = null;
      let counter = 0;
      for(let i = openIndex; i < str.length; i += 1){
        if(str[i] === '(') counter += 1;
        if(str[i] === ')') counter -= 1;
        if(counter === 0) {
          closeIndex = i;
          break;
        }
      }

      if(!closeIndex) closeIndex = str.length - 1;

      return [
        str,
        str.slice(0,openIndex), // Name of the function
        str.slice(openIndex+1,closeIndex), // All the params
        str.slice(closeIndex+1) // Prop accessor
      ];
    };

    if(!matches) return splitInThree(exp);
    return splitInThree(matches[1]);
  }

  //
  // Main ARM expression parser, attempts to evaluate and resolve ARM expressions 
  // Most of the time it will evaluate down to a string, but a number can be returned also
  //
  public evalHelper(exp: string, check = false): any {
    // Catch some rare errors where non-strings are parsed
    if(typeof exp != "string")
      return exp;
    if(exp.startsWith('{{'))
      return exp;

    // Precheck called on top level calls to _evalExpression
    if(check) {
      const match = exp.match(/^\[(.*)\]$/);
      if(match) {
        exp = match[1];
      } else {
        return exp;
      }
    }

    exp = exp.trim();
    
    // It looks like a function call with a property reference e.g foo().bar or foo()['bar']
    let match = this.funcCallWithPropertyExtractor(exp);
    let funcProps = undefined;
    if(match) {
      const funcName = match[1];
      const funcParams = match[2];
      funcProps = match[3];

      // Catch some special cases, with referenced properties, e.g. resourceGroup().location
      if(funcName == 'resourceGroup' && funcProps == '.id') return '{res-group-id}'; 
      if(funcName == 'resourceGroup' && funcProps == '.location') return '{res-group-location}'; 
      if(funcName == 'subscription' && funcProps == '.subscriptionid') return '{subscription-id}'; 
      if(funcName == 'deployment' && funcProps == '.name') return '{deployment-name}'; 

      if(funcName == 'variables') {
        return this.funcVarParam(this.template.variables, this.eval(funcParams), funcProps,'variables');
      } 

      if(funcName == 'parameters') {
        return this.funcVarParam(this.template.parameters, this.eval(funcParams), funcProps,'parameters');
      }

      if(funcName == 'union'){
        return this.funcUnion(funcParams,funcProps);
      }

      if(funcName == 'reference') {
        // Outputs will be resolved in the second pass
        if(funcProps.indexOf('outputs') > -1) {
          return `[pending_reference(${funcParams})${funcProps}]`;
        }
        return this.funcReferenceParam(this.eval(funcParams), funcProps);
      }

      // Will be resolved in second pass
      if(funcName == 'pending_reference' && this.secondPass) {
        // e.g. 'foo/[pending_reference('arg').prop]/bar'
        // should resolve to 'foo/something/bar'
        const result = this.funcReferenceParam(this.eval(funcParams), funcProps);
        return exp.replace(`[${match[0]}]`,result);
      }
    }

    // It looks like a 'plain' function call without . something after it
    // For historic reasons we treat these separate and I don't want to mess with it, as it works
    match = exp.match(/(\w+)\((.*)\)/);
    if(match) {
      const funcName = match[1].toLowerCase();
      const funcParams = match[2];
      
      if(funcName == 'variables') {
        return this.funcVarParam(this.template.variables, this.eval(funcParams), '','variables');
      }
      if(funcName == 'parameters') {
        return this.funcVarParam(this.template.parameters, this.eval(funcParams), '','parameters');
      }        
      if(funcName == 'uniquestring') {
        return this.funcUniqueString(this.eval(funcParams));
      }   
      if(funcName == 'concat') {
        return this.funcConcat(funcParams, '');
      }
      if(funcName == 'uri') {
        return this.funcUri(funcParams);
      }
      if(funcName == 'replace') {
        return this.funcReplace(funcParams);
      }      
      if(funcName == 'tolower') {
        return this.funcToLower(funcParams);
      }        
      if(funcName == 'toupper') {
        return this.funcToUpper(funcParams);
      } 
      if(funcName == 'substring') {
        return this.funcSubstring(funcParams);
      }    
      if(funcName == 'resourceid') {
        // Treat resourceId as a concat operation with slashes 
        let resid = this.funcConcat(funcParams, '/');
        // clean up needed
        resid = resid.replace(/^\//, '');
        resid = resid.replace(/\/\//, '/');
        return resid;
      }    
      if(funcName == 'copyindex') {
        return 0;
      }
      if(funcName == 'guid') {
        return uuidv5(this.funcConcat(funcParams, ''), '36c56b01-f9c9-4c7d-9786-0372733417ea');
      }
      if(funcName == 'union'){
        return this.funcUnion(funcParams,'');
      }
    }

    // It looks like a string literal in single quotes
    match = exp.match(/^\'(.*)\'$/);
    if(match) {
      return match[1];
    }

    // It looks like a number literal
    // End with $ to not match guids
    match = exp.match(/^(\d+)$/);
    if(match) {
      return match[1].toString();
    }

    // Catch all, just return the expression, unparsed
    return exp;
  }

  //
  // Locate a resource by resource id
  //
  private findResource(name: string) {
    return this.template.resources.find(res => {
      const resolvedName = this.eval(res.name);
      return resolvedName === name;
    });
  }

  //
  // Find property of reference
  //
  private funcReferenceParam(name: string, propAccessor: string) {
    const resource = this.findResource(name);
    if(propAccessor.startsWith('.')) propAccessor = propAccessor.slice(1);
    return _.get(resource,propAccessor,'{invalid_reference}');
  }

  private funcVarParam(source: any, varName: string, propAccessor: string,paramOrVal: string) {
    const result = this.funcVarParamHelper(source,varName,propAccessor,paramOrVal);
    return result;
  }

  //
  // Emulate the ARM function `variables()` and `parameters()` to reference template variables/parameters
  // The only difference is the source 
  //
  private funcVarParamHelper(source: any, varName: string, propAccessor: string, paramOrVal: string) {
    // propAccessor is the . or [] part of the object accessor
    // the [] notation requires some pre-processing for expressions e.g. foo[variable('bar')]
    if(propAccessor && propAccessor.charAt(0) == '['
       && !(propAccessor.charAt(1) >= '0' && propAccessor.charAt(1) <= '9')
       && !(propAccessor.charAt(1) == "'")) {
      // Evaluate propAccessor in case it includes an expression
      let propAccessorResolved = this.eval(propAccessor, false);
   
      // If we get a string back it need's quoting, e.g. foo['baz']
      if(typeof propAccessorResolved == 'string') {
        propAccessorResolved = `'${propAccessorResolved}'`;
      }
      // Otherwise it's hopefully a number 
      propAccessor = `[${propAccessorResolved}]`;
    }

    if(!source) return "{undefined}";
    const findKey = Object.keys(source).find(key => varName == key);
    if(findKey) {
      let val;
      
      // For parameters we access `defaultValue`
      if(source == this.template.parameters) {
        val = source[findKey].defaultValue;
        // Without a defaultValue it is impossible to know what the parameters value could be!
        // So a fall-back out is to return the param name inside {}
        if(!val && val !== 0)
          return `{${this.eval(varName)}}`;
      } else {
        // For variables we use the actual value
        val = source[findKey];
      }

      // Variables can be JSON objects, MASSIVE SIGH LOOK AT THIS INSANITY
      if(typeof(val) == 'object') {
        if(!propAccessor) {
          // We're dealing with an object and have no property accessor, nothing we can do
          return `{${JSON.stringify(val)}}`;
        }
        
        // Hack to try to handle copyIndex, default to first item in array
        propAccessor = propAccessor.replace('copyIndex()', '0');

        // Use lodash get to resolve accessors
        try {
          propAccessor = propAccessor.startsWith('.') ? propAccessor.slice(1) : propAccessor;
          const evalResult = _.get(val, propAccessor);

          if(typeof(evalResult) == 'undefined') {
            console.log(`### ArmView: Warn! Your template contains invalid references: ${varName} -> ${propAccessor}`);
            return `${paramOrVal}('${varName}')${propAccessor}`;
          }

          if(typeof(evalResult) == 'string') {
            // variable references values can be expressions too, so down the rabbit hole we go...
            return this.eval(evalResult, true);
          }

          if(typeof(evalResult) == 'object') {
            // We got an object back, give up
            return `{${JSON.stringify(evalResult)}}`;
          }
        } catch(err) {
          console.log(`### ArmView: Warn! Your template contains invalid references: ${varName} -> ${propAccessor}`);
          return `${paramOrVal}('${varName}')${propAccessor}`;
        }
      }

      if(typeof(val) == 'string') {
        // variable values can be expressions too, so down the rabbit hole we go...
        const evalResult = this.eval(val, true);
        propAccessor = propAccessor.startsWith('.') ? propAccessor.slice(1) : propAccessor;
        if(propAccessor) return _.get(this.tryParseJson(evalResult), propAccessor);
        return evalResult;
      }
      
      // Fall back
      return val;
    } else {
      console.log(`### ArmView: Warn! Your template contains invalid references: ${varName} -> ${propAccessor}`);
      return `${paramOrVal}('${varName}')${propAccessor}`;
    }
  }

  //
  // Emulate the ARM function `uniqueString()` 
  //
  private funcUniqueString(baseStr: string): string {
    const hash = utils.hashCode(baseStr || 'EMPTY');
    return Buffer.from(`${hash}`).toString('base64').substr(0, 14);
  }

  //
  // Emulate the ARM function `concat()` 
  //
  private funcConcat(funcParams: string, joinStr: string) {
    const paramList = this.parseParams(funcParams);

    let res = "";
    for(const p in paramList) {
      let param = paramList[p];
      try {
        param = param.trim();
      } catch(err) {}
      res += joinStr + this.eval(param);
    }
    return res;
  }

  private tryParseJson(maybeJsonString: string) {
    try{
      const parsedJson = typeof(maybeJsonString) === 'object' ? 
         maybeJsonString : JSON.parse(maybeJsonString.substr(1, maybeJsonString.length-2));
      return parsedJson;
    }catch(e){
      // TODO: Find out what is causing this breakage
      // console.error('Unable to parse:', maybeJsonString);
      // console.error(e);
      return maybeJsonString;
    }
  }

  //
  // Emulate the ARM function `union()`
  //
  private funcUnion(funcParams: string, funcProps: string) {
    const paramList = this.parseParams(funcParams);

    const unionedObj = paramList.reduce((acc,param)=>{
      const evaledParam = this.eval(param);
      const parsedJson = this.tryParseJson(evaledParam);

      if(typeof(parsedJson) === 'string') return acc;
      
      // Eval the contents of the JSON
      const flatTemplate: any = flat.flatten(parsedJson);
      Object.keys(flatTemplate).forEach((k) => {
        flatTemplate[k] = this.eval(flatTemplate[k]);
        flatTemplate[k] = this.tryParseJson(flatTemplate[k]);
      });
      const evaledJson = flat.unflatten(flatTemplate);

      return _.merge(acc,evaledJson);
    },{});

    // If prop accessor is present then access it
    if(funcProps.startsWith('.')) funcProps = funcProps.slice(1);
    if(funcProps.length){
      const resolved = _.get(unionedObj,funcProps);
      if(typeof resolved === 'string' ) return resolved;
      return `{${JSON.stringify(resolved)}}`;
    }

    return `{${JSON.stringify(unionedObj)}}`;
  }

  //
  // Emulate the ARM function `uri()` 
  //
  private funcUri(funcParams: string) {
    const paramList = this.parseParams(funcParams);

    if(paramList.length == 2) {
      let sep = '';
      let base = this.eval(paramList[0]);
      const rel = this.eval(paramList[1]);
      if(!(base.endsWith('/') || rel.startsWith('/'))) sep = '/';
      if(base.endsWith('/') && rel.startsWith('/')) {
        sep = '';
        base = base.substr(0, base.length - 1);
      }

      return base + sep + rel;
    }

    return "{invalid-uri}";
  }  

  //
  // Emulate the ARM function `replace()` 
  //
  private funcReplace(funcParams: string) {
    const paramList = this.parseParams(funcParams);
    const input = this.eval(paramList[0]);
    const search = this.eval(paramList[1]);
    const replace = this.eval(paramList[2]);
    
    return input.replace(new RegExp(search, 'g'), replace);
  } 
  
  //
  // Emulate the ARM function `toLower()` 
  //
  private funcToLower(funcParams: string) {
    return this.eval(funcParams).toLowerCase();
  }

  //
  // Emulate the ARM function `toUpper()` 
  //
  private funcToUpper(funcParams: string) {
    return this.eval(funcParams).toUpperCase();
  }

  //
  // Emulate the ARM function `substring()` 
  //
  private funcSubstring(funcParams: string) {
    const paramList = this.parseParams(funcParams);
    const str = this.eval(paramList[0]);
    const start = parseInt(this.eval(paramList[1]));
    const len = parseInt(this.eval(paramList[2]));
    
    return this.eval(str).substring(start, start + len);
  }

  //
  // This is a brute force parser for comma separated parameter lists in function calls, e.g. foo(bar, thing(1, 2))
  //
  private parseParams(paramString: string) {
    // Parsing non-nested commas in a param list is IMPOSSIBLE WITH A REGEX
    let depth = 0;
    const parts = [];
    let lastSplit = 0;
    for(let i = 0; i < paramString.length; i++) {
      const c = paramString.charAt(i); //paramString[i];
      if(c === '(') depth++;
      if(c === ')') depth--;

      const endOfString = i == paramString.length-1;
      if((c === ',' && depth == 0) || endOfString) {
        const endPoint = endOfString ? paramString.length : i;
        parts.push(paramString.substring(lastSplit, endPoint).trim());
        lastSplit = i + 1;
      }
    }
    return parts;
  }
}
