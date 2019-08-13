/// <reference path="./src/@types/gaba.d.ts" />
/// <reference path="./src/@types/index.d.ts" />

import uuid from 'uuid/v4';

const JsonRpcEngine = require('json-rpc-engine');
const asMiddleware = require('json-rpc-engine/src/asMiddleware');
import {
  JsonRpcEngine as IJsonRpcEngine,
  JsonRpcEngineNextCallback,
  JsonRpcEngineEndCallback,
  JsonRpcMiddleware,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcEngine
} from 'json-rpc-engine';

import { BaseController } from 'gaba';

import {
  ICaveatFunction,
  filterParams,
  filterResponse,
  ICaveatFunctionGenerator,
} from './src/caveats';

import { 
  RpcCapInterface,
  RestrictedMethodMap,
  UserApprovalPrompt,
  AuthenticatedJsonRpcMiddleware,
  CapabilitiesConfig,
  CapabilitiesState,
  IOriginMetadata,
  IPermissionsRequest,
  IRequestedPermissions,
  RpcCapDomainEntry,
  RpcCapDomainRegistry,
  IOriginString,
 } from './src/@types';

import {
  unauthorized,
  invalidReq,
  USER_REJECTED_ERROR,
  METHOD_NOT_FOUND
} from './src/errors';

import { IOcapLdCapability, IOcapLdCaveat } from './src/@types/ocap-ld';

class Capability implements IOcapLdCapability {
  public '@context':string[] = ['https://github.com/MetaMask/json-rpc-capabilities-middleware'];
  public parentCapability: string;
  public caveats: IOcapLdCaveat[] | undefined;
  public id: string;
  public date: number;
  public invoker: IOriginString;

  constructor ({ method, caveats, invoker }: {
    method: string;
    caveats?: IOcapLdCaveat[];
    invoker: IOriginString;
  }) {
    this.parentCapability = method;
    this.caveats = caveats;
    this.id = uuid();
    this.date = Date.now();
    this.invoker = invoker;
  }

  toJSON(): IOcapLdCapability {
    return {
      '@context': this['@context'],
      invoker: this.invoker,
      parentCapability: this.parentCapability,
      id: this.id,
      date: this.date,
      caveats: this.caveats,
    }
  }

  toString():string {
    return JSON.stringify(this.toJSON());
  }
}

export class CapabilitiesController extends BaseController<any, any> implements RpcCapInterface {
  private safeMethods: string[];
  private restrictedMethods: RestrictedMethodMap;
  private requestUserApproval: UserApprovalPrompt;
  private internalMethods: { [methodName: string]: AuthenticatedJsonRpcMiddleware }
  private caveats: { [ name:string]: ICaveatFunctionGenerator } = { filterParams, filterResponse };
  private methodPrefix: string;
  private engine: JsonRpcEngine | undefined;

  constructor(config: CapabilitiesConfig, state?: Partial<CapabilitiesState>) {
    super(config, state || {});

    this.safeMethods = config.safeMethods || [];
    this.restrictedMethods = config.restrictedMethods || {};
    this.methodPrefix = config.methodPrefix || '';
    this.engine = config.engine || undefined;

    if (!config.requestUserApproval) {
      throw "User approval prompt required.";
    }
    this.requestUserApproval = config.requestUserApproval;

    this.defaultState = {
      permissionsRequests: [],
      permissionsDescriptions: Object.keys(
        this.restrictedMethods
      ).reduce<{[key:string]:string}>(
        (acc, methodName) => {
          acc[methodName] = this.restrictedMethods[methodName].description
          return acc;
        },
      {}),
    }

    this.internalMethods = {};
    this.internalMethods[`${this.methodPrefix}getPermissions`] = this.getPermissionsMiddleware.bind(this);
    this.internalMethods[`${this.methodPrefix}requestPermissions`] = this.requestPermissionsMiddleware.bind(this);

    this.initialize();
  }

  serialize () {
    return this.state;
  }
  /**
   * Returns a capabilities middleware function bound to its parent
   * CapabilitiesController object with the given domain as its
   * first argument.
   * @param  {string} domain the domain to bind the middleware to
   */
  createBoundMiddleware (domain: string) {
    return this.providerMiddlewareFunction.bind(this, { origin: domain })
  }

  /**
   * Returns a JsonRpcEngine with a single, bound capabilities middleware with
   * the given domain as its first argument.
   * See createBoundMiddleware for more information.
   * @param  {string} domain the domain to bind the middleware to
   */
  createPermissionedEngine (domain: string) {
    const engine = new JsonRpcEngine()
    engine.push(this.createBoundMiddleware(domain))
    return engine
  }

  /**
   * Returns a nearly json-rpc-engine compatible method.
   * The one difference being the first argument should be
   * a unique string identifying the requesting agent/entity,
   * referred to as `domain` in the code. This allows the function
   * to be curried and converted into a normal json-rpc-middleware function.
   */
  providerMiddlewareFunction (
    domain: IOriginMetadata,
    req: JsonRpcRequest<any>,
    res: JsonRpcResponse<any>,
    next: JsonRpcEngineNextCallback,
    end: JsonRpcEngineEndCallback,
  ) : void {
    const methodName = req.method;

    // skip registered safe/passthrough methods.
    if (this.safeMethods.includes(methodName)) {
      return next();
    }

    // handle internal methods before any restricted methods.
    if (this.internalMethods[methodName]) {
      return this.internalMethods[methodName](domain, req, res, next, end);
    }

    let permission;
    try {
      permission = this.getPermission(domain.origin, methodName);
    } catch (err) {
      res.error = {
        message: err.message,
        code: 1,
      };
      return end(res.error);
    }

    if (!permission) {
      res.error = unauthorized(req);
      return end(res.error);
    }

    this.executeMethod(domain, req, res, next, end);
  }

  /**
   * Used for retrieving the key that manages the restricted method
   * associated with the current RPC `method` key.
   * 
   * Used to support our namespaced method feature, which allows blocks
   * of methods to be hidden behind a restricted method with a trailing `_` character.
   * 
   * @param method string - The requested rpc method.
   * @returns methodKey string
   */
  getMethodKeyFor(method: string): string {
    const managedMethods: string[] = Object.keys(this.restrictedMethods);

    // Return exact matches:
    if (managedMethods.includes(method)) {
      return method;
    }

    // Check for potentially nested namespaces:
    // Ex: wildzone_
    // Ex: eth_plugin_
    if (method.indexOf('_') > 0) {

      const segments = method.split('_');
      let managed: string = '';

      while (segments.length > 0 && !managedMethods.includes(managed)) {
        managed += segments.shift() + '_';
      }

      if (managedMethods.includes(managed)) {
        return managed;
      } else {
        return '';
      }
    } else {
      return managedMethods.includes(method) ? method : '';
    }
  }

  executeMethod (
    domain: IOriginMetadata,
    req: JsonRpcRequest<any>,
    res: JsonRpcResponse<any>,
    next: JsonRpcEngineNextCallback,
    end: JsonRpcEngineEndCallback,
  ) : void {
    const methodKey = this.getMethodKeyFor(req.method);
    const permission = this.getPermission(domain.origin, req.method);
    if (methodKey && typeof this.restrictedMethods[methodKey].method === 'function') {
      const virtualEngine = this.createVirtualEngineFor(domain);

      // Check for Caveats:
      if (permission !== undefined && permission.caveats && permission.caveats.length > 0) {
        const engine: IJsonRpcEngine = new JsonRpcEngine();

        permission.caveats.forEach((serializedCaveat: IOcapLdCaveat) => {
          const caveatFnGens = this.caveats;
          const caveatFnGen: ICaveatFunctionGenerator = caveatFnGens[serializedCaveat.type];
          const caveatFn: ICaveatFunction = caveatFnGen(serializedCaveat);
          engine.push(caveatFn);
        });

        engine.push((req, res, next, end) => {
          return this.restrictedMethods[methodKey].method(req, res, next, end, virtualEngine)
        });

        const middleware: JsonRpcMiddleware = asMiddleware(engine);
        return middleware(req, res, next, end);

      } else {
        return this.restrictedMethods[methodKey].method(req, res, next, end, virtualEngine);
      }
    }

    res.error = METHOD_NOT_FOUND;
    return end(METHOD_NOT_FOUND);
  }

  createVirtualEngineFor (domain: IOriginMetadata): JsonRpcEngine {
    const engine: IJsonRpcEngine = new JsonRpcEngine();
    engine.push(this.providerMiddlewareFunction.bind(this, domain));

    /**
     * If an engine was provided, it is used as the final step
     * for the middleware provider.
     */
    if (this.engine) {
      engine.push(asMiddleware(this.engine));
    }

    return engine;
  }

  getPermissionsForDomain (domain: string): IOcapLdCapability[] {
    const { domains = {} } = this.state;
    if (domains[domain]) {
      const { permissions } = domains[domain];
      return permissions;
    }
    return [];
  }

  /**
   * Get the parent-most permission granting the requested domain's method permission.
   * Follows the delegation chain of the first matching permission found.
   * 
   * @param {string} domain - The domain whose permission to retrieve.
   * @param {string} method - The method
   */
  getPermission (domain: string, method: string): IOcapLdCapability | undefined {
    let permissions = this.getPermissionsForDomain(domain).filter(p => {
      return p.parentCapability === method;
    });
    if (permissions.length > 0) { return permissions.shift(); }

    return undefined;
  }

  /**
   * Gets current permissions request objects.
   * Useful for displaying information for user consent.
   */
  getPermissionsRequests (): IPermissionsRequest[] {
    const reqs = this.state.permissionsRequests;
    return reqs || [];
  }

  /**
   * Used for removing a permissions request from the permissions request array.
   * 
   * @param request The request that no longer requires user attention.
   */
  removePermissionsRequest (requestId: string) : void {
    const reqs = this.getPermissionsRequests().filter((oldReq) => {
      return oldReq.metadata.id !== requestId;
    })
    this.setPermissionsRequests(reqs);
  }

  setPermissionsRequests (permissionsRequests: IPermissionsRequest[]) {
    this.update({ permissionsRequests });
  }

  /**
   * Used for granting a new set of permissions,
   * after the user has approved it.
   * 
   * @param {string} domain - The domain receiving new permissions.
   * @param {IRequestedPermissions} approvedPermissions - An object of objects describing the granted permissions.
   * @param {JsonRpcResponse} res - The response.
   * @param {JsonRpcEngineEndCallback} end - The end function.
   */
  grantNewPermissions (domain: string, approved: IRequestedPermissions, 
    res: JsonRpcResponse<any>, end: JsonRpcEngineEndCallback) {

    // Enforce actual approving known methods:
    for (let methodName in approved) {
      const exists = this.getMethodKeyFor(methodName);
      if (!exists) {
        res.error = METHOD_NOT_FOUND;
        return end(res.error);
      }
    }

    const permissions: { [methodName: string]: IOcapLdCapability } = {};

    for (let method in approved) {
      const newPerm = new Capability({ method, invoker: domain, caveats: approved[method].caveats });
      permissions[method] = newPerm;
    }

    this.addPermissionsFor(domain, permissions);
    res.result = this.getPermissionsForDomain(domain);
    end();
  }

  getDomains () : RpcCapDomainRegistry {
    const { domains } = this.state;
    return domains || {};
  }

  setDomains (domains: RpcCapDomainRegistry) : void {
    this.update({ domains });
  }

  getOrCreateDomainSettings (domain: string): RpcCapDomainEntry {
    const entry = this.getDomainSettings(domain);
    if (entry === undefined) {
      return { permissions: [] };
    } else {
      return entry;
    }
  }

  getDomainSettings (domain: string): RpcCapDomainEntry {
    const domains = this.getDomains();

    // Setup if not yet existent:
    if (!domains[domain]) {
      const newDomain = { permissions: [] };
      domains[domain] = newDomain;
      return newDomain;
    }

    return domains[domain];
  }

  setDomain (domain: IOriginString, domainSettings: RpcCapDomainEntry) {
    const domains = this.getDomains();
    if (domainSettings.permissions.length > 0) {
      domains[domain] = domainSettings;
    } else {
      delete domains[domain]
    }
    this.setDomains(domains)
  }

  /**
   * Adds permissions to the given domain. Overwrites existing identical
   * permissions (same domain, and method). Other existing permissions
   * remain unaffected.
   * 
   * @param {string} domainName - The grantee domain.
   * @param {Array} newPermissions - The unique, new permissions for the grantee domain.
   */
  addPermissionsFor (domainName: string, newPermissions: { [methodName:string]: IOcapLdCapability }) {
    const domain: RpcCapDomainEntry = this.getOrCreateDomainSettings(domainName);
    const newKeys = Object.keys(newPermissions);

    // remove old permissions this will be overwritten
    domain.permissions = domain.permissions.filter((oldPerm: IOcapLdCapability) => {
      return !newKeys.includes(oldPerm.parentCapability);
    });

    for (let methodName in newPermissions) {
      let newPerm = newPermissions[methodName];
      
      domain.permissions.push(new Capability({
        method: newPerm.parentCapability,
        invoker: domainName,
        caveats: newPerm.caveats,
      }));
    }

    this.setDomain(domainName, domain);
  }

  /**
   * Removes the specified permissions from the given domain.
   * 
   * @param {string} domainName - The domain name whose permissions to remove.
   * @param {Array} permissionsToRemove - Objects identifying the permissions to remove.
   */
  removePermissionsFor (
    domainName: string,
    permissionsToRemove: IOcapLdCapability[]
  ) {
    const domain = this.getDomainSettings(domainName);

    if (domain === undefined || domain.permissions === undefined) {
      return;
    }

    domain.permissions = domain.permissions.filter(
      (perm: IOcapLdCapability) => {
        for (let r of permissionsToRemove) {
          if (r.parentCapability === perm.parentCapability) {
            return false;
          }
        }
        return true;
      }
    );

    this.setDomain(domainName, domain);
  }

  /**
   * Clear all domains (and thereby remove all permissions).
   */
  clearDomains () {
    this.setDomains({})
  }

  /**
   * Check if a request to requestPermissionsMiddleware is valid.
   */
  isValidPermissionsRequest (req: JsonRpcRequest<any>): boolean {
    if (
      !req ||
      !Array.isArray(req.params) ||
      typeof req.params[0] !== 'object' ||
      Array.isArray(req.params[0])
    ) {
      return false;
    }

    const perms: IRequestedPermissions = req.params[0]
    for (let key of Object.keys(perms)) {
      if (
        perms[key].parentCapability !== undefined &&
        key !== perms[key].parentCapability
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * The capabilities middleware function used for getting permissions for a
   * specific domain.
   */
  getPermissionsMiddleware (
    domain: IOriginMetadata,
    _req: JsonRpcRequest<any>,
    res: JsonRpcResponse<any>,
    _next: JsonRpcEngineNextCallback,
    end: JsonRpcEngineEndCallback)
  {
    const permissions = this.getPermissionsForDomain(domain.origin);
    res.result = permissions;
    end();
  }

  /**
   * The capabilities middleware function used for requesting additional permissions from the user.
   */
  requestPermissionsMiddleware (
    metadata: IOriginMetadata,
    req: JsonRpcRequest<any>,
    res: JsonRpcResponse<any>,
    _next: JsonRpcEngineNextCallback,
    end: JsonRpcEngineEndCallback,
  ) : void {

    // validate request
    if (!this.isValidPermissionsRequest(req)
    ) {
      res.error = invalidReq(req);
      return end(res.error);
    }

    // get additional metadata from params if it exists
    if (
      req.params.length === 2 &&
      req.params[1].metadata
    ) {
      metadata = { ...req.params.pop().metadata, ...metadata }
    }

    if (!metadata.id) {
      metadata.id = uuid();
    }

    const permissions: IRequestedPermissions = req.params[0];
    const requests = this.getPermissionsRequests();

    const permissionsRequest: IPermissionsRequest = {
      origin: metadata.origin,
      metadata,
      permissions: permissions,
    };

    requests.push(permissionsRequest);
    this.setPermissionsRequests(requests);

    this.requestUserApproval(permissionsRequest)
    // TODO: Allow user to pass back an object describing
    // the approved permissions, allowing user-customization.
    .then((approved: IRequestedPermissions) => {
      if (Object.keys(approved).length === 0) {
        res.error = USER_REJECTED_ERROR;
        return end(USER_REJECTED_ERROR);
      }

      if (!permissionsRequest.metadata.id) {
        res.error = invalidReq();
        return end(res.error);
      }

      // If user approval is different, use it as the permissions:
      this.grantNewPermissions(metadata.origin, approved, res, end);
    })
    .catch((reason) => {
      res.error = reason;
      return end(reason);
    })
    .finally(() => {
      // Delete the request object
      if (permissionsRequest.metadata.id) {
        this.removePermissionsRequest(permissionsRequest.metadata.id)
      }
    });
  }
}
