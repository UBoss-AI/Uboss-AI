import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { AUTH_CONFIG, type AuthConfig } from '../auth.config.js';
import { AllowAnonymous } from '../../tenancy/tenancy.decorators.js';
import { Inject } from '@nestjs/common';
import {
  ScimService,
  type ScimGroupInput,
  type ScimPrincipal,
  type ScimUserInput,
} from './scim.service.js';
import {
  parseEqualityFilter,
  SCIM_SCHEMAS,
  scimList,
  type ScimPatchOperation,
} from './scim.types.js';

/**
 * SCIM 2.0 endpoints (RFC 7644).
 *
 * ## Why these are `@AllowAnonymous`
 *
 * A SCIM request carries a **bearer token that is not a UBoss session**. The tenancy guard knows
 * about sessions and dev headers, so from its point of view these calls are anonymous — and they
 * are, until this controller authenticates the token itself. That is the same pattern `logout`
 * and the invitation-activation routes use: the credential is something the handler reads and
 * verifies, and `@AllowAnonymous` says "the guard has nothing to check here", not "no credential
 * is required". Every method below starts by authenticating, and `authenticate` throws when the
 * token is missing, unknown, revoked, or belongs to a company that is not active.
 *
 * The important property is that the token *is* the tenant scope: no SCIM path or body carries a
 * tenant id, so there is nothing for a caller to tamper with to reach another company.
 *
 * ## Content type
 *
 * SCIM specifies `application/scim+json`. Responses set it explicitly, and requests are accepted
 * with either that or `application/json` — several connectors send the latter, and rejecting them
 * over a header would be pedantry that breaks real integrations.
 */
@Controller('scim/v2')
@AllowAnonymous()
export class ScimController {
  private readonly logger = new Logger(ScimController.name);

  constructor(
    private readonly scim: ScimService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * What this server supports.
   *
   * Every unsupported feature is declared `false` rather than omitted. A connector reads this
   * and adapts; one that finds `patch: true` and then hits an unsupported path gets a runtime
   * failure it cannot plan around.
   *
   * Reachable without a credential, deliberately: an administrator configuring a connector needs
   * to see the document before the token exists, and it contains no company-specific information.
   */
  @Get('ServiceProviderConfig')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  serviceProviderConfig() {
    return {
      schemas: [SCIM_SCHEMAS.serviceProviderConfig],
      documentationUri: `${this.config.webBaseUrl}/docs/scim`,
      // Supported, but only for the operations named in `understandPatch`. Anything else is
      // refused with `invalidPath` rather than silently ignored.
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 500 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description:
            'A provisioning token issued from the UBoss Master Console. It scopes every request ' +
            'to exactly one company.',
          primary: true,
        },
      ],
      meta: { resourceType: 'ServiceProviderConfig', location: this.base('ServiceProviderConfig') },
    };
  }

  @Get('ResourceTypes')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  resourceTypes() {
    const types = [
      {
        schemas: [SCIM_SCHEMAS.resourceType],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        description: 'A member of this company.',
        schema: SCIM_SCHEMAS.user,
        meta: { resourceType: 'ResourceType', location: this.base('ResourceTypes/User') },
      },
      {
        schemas: [SCIM_SCHEMAS.resourceType],
        id: 'Group',
        name: 'Group',
        endpoint: '/Groups',
        description: 'A group inside this company.',
        schema: SCIM_SCHEMAS.group,
        meta: { resourceType: 'ResourceType', location: this.base('ResourceTypes/Group') },
      },
    ];

    return scimList(types, types.length, 1, types.length);
  }

  /**
   * The attributes this server actually stores.
   *
   * Trimmed to what UBoss holds — a connector that reads this will not try to push `addresses`,
   * `phoneNumbers` or `entitlements` and then find them silently discarded.
   */
  @Get('Schemas')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  schemas() {
    const schemas = [
      {
        schemas: [SCIM_SCHEMAS.schema],
        id: SCIM_SCHEMAS.user,
        name: 'User',
        description: 'SCIM core User, restricted to the attributes UBoss stores.',
        attributes: [
          attribute('userName', 'string', { required: true, uniqueness: 'server' }),
          attribute('displayName', 'string'),
          attribute('externalId', 'string'),
          attribute('active', 'boolean'),
          {
            ...attribute('emails', 'complex', { multiValued: true }),
            subAttributes: [
              attribute('value', 'string'),
              attribute('primary', 'boolean'),
              attribute('type', 'string'),
            ],
          },
          {
            ...attribute('groups', 'complex', { multiValued: true, mutability: 'readOnly' }),
            subAttributes: [attribute('value', 'string'), attribute('display', 'string')],
          },
        ],
        meta: { resourceType: 'Schema', location: this.base(`Schemas/${SCIM_SCHEMAS.user}`) },
      },
      {
        schemas: [SCIM_SCHEMAS.schema],
        id: SCIM_SCHEMAS.group,
        name: 'Group',
        description: 'SCIM core Group.',
        attributes: [
          attribute('displayName', 'string', { required: true, uniqueness: 'server' }),
          attribute('externalId', 'string'),
          {
            ...attribute('members', 'complex', { multiValued: true }),
            subAttributes: [attribute('value', 'string'), attribute('display', 'string')],
          },
        ],
        meta: { resourceType: 'Schema', location: this.base(`Schemas/${SCIM_SCHEMAS.group}`) },
      },
    ];

    return scimList(schemas, schemas.length, 1, schemas.length);
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  @Get('Users')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  async listUsers(
    @Req() request: Request,
    @Query('filter') filter?: string,
    @Query('startIndex') startIndex?: string,
    @Query('count') count?: string,
  ) {
    const principal = await this.authenticate(request);
    const page = this.pageFrom(startIndex, count);
    const parsed = this.filterFrom(filter);

    const { resources, total } = await this.scim.listUsers(
      principal,
      { ...parsed, ...page },
      (id) => this.base(`Users/${id}`),
    );

    return scimList(resources, total, page.startIndex, resources.length);
  }

  @Get('Users/:id')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  async getUser(@Req() request: Request, @Param('id') id: string) {
    const principal = await this.authenticate(request);
    return this.scim.getUser(principal, id, (userId) => this.base(`Users/${userId}`));
  }

  @Post('Users')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  @HttpCode(HttpStatus.CREATED)
  async createUser(@Req() request: Request, @Body() body: ScimUserInput) {
    const principal = await this.authenticate(request);
    const result = await this.scim.createUser(principal, body, (userId) =>
      this.base(`Users/${userId}`),
    );
    return result.user;
  }

  @Put('Users/:id')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  async replaceUser(@Req() request: Request, @Param('id') id: string, @Body() body: ScimUserInput) {
    const principal = await this.authenticate(request);
    return this.scim.replaceUser(principal, id, body, (userId) => this.base(`Users/${userId}`));
  }

  @Patch('Users/:id')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  async patchUser(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { schemas?: string[]; Operations?: ScimPatchOperation[] },
  ) {
    const principal = await this.authenticate(request);
    return this.scim.patchUser(principal, id, operationsFrom(body), (userId) =>
      this.base(`Users/${userId}`),
    );
  }

  /**
   * Deprovision.
   *
   * Returns 204 and moves the membership to `Offboarded`; it does not delete the row. See the
   * `ScimService` comment for why — an identity provider that briefly loses sight of someone must
   * not be able to destroy the record of their employment.
   */
  @Delete('Users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteUser(@Req() request: Request, @Param('id') id: string) {
    const principal = await this.authenticate(request);
    await this.scim.deleteUser(principal, id);
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  @Get('Groups')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  async listGroups(
    @Req() request: Request,
    @Query('filter') filter?: string,
    @Query('startIndex') startIndex?: string,
    @Query('count') count?: string,
  ) {
    const principal = await this.authenticate(request);
    const page = this.pageFrom(startIndex, count);
    const parsed = this.filterFrom(filter);

    const { resources, total } = await this.scim.listGroups(
      principal,
      { ...parsed, ...page },
      (id) => this.base(`Groups/${id}`),
    );

    return scimList(resources, total, page.startIndex, resources.length);
  }

  @Get('Groups/:id')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  async getGroup(@Req() request: Request, @Param('id') id: string) {
    const principal = await this.authenticate(request);
    return this.scim.getGroup(principal, id, (groupId) => this.base(`Groups/${groupId}`));
  }

  @Post('Groups')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  @HttpCode(HttpStatus.CREATED)
  async createGroup(@Req() request: Request, @Body() body: ScimGroupInput) {
    const principal = await this.authenticate(request);
    return this.scim.createGroup(principal, body, (groupId) => this.base(`Groups/${groupId}`));
  }

  @Put('Groups/:id')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  async replaceGroup(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: ScimGroupInput,
  ) {
    const principal = await this.authenticate(request);
    return this.scim.replaceGroup(principal, id, body, (groupId) => this.base(`Groups/${groupId}`));
  }

  @Patch('Groups/:id')
  @Header('content-type', 'application/scim+json; charset=utf-8')
  async patchGroup(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { schemas?: string[]; Operations?: ScimPatchOperation[] },
  ) {
    const principal = await this.authenticate(request);
    return this.scim.patchGroup(principal, id, operationsFrom(body), (groupId) =>
      this.base(`Groups/${groupId}`),
    );
  }

  @Delete('Groups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteGroup(@Req() request: Request, @Param('id') id: string) {
    const principal = await this.authenticate(request);
    await this.scim.deleteGroup(principal, id);
  }

  // -------------------------------------------------------------------------

  /**
   * Authenticate the bearer token, or refuse.
   *
   * One answer for missing, malformed, unknown, revoked and belonging-to-an-inactive-company, so
   * a caller cannot probe which tokens exist.
   */
  private async authenticate(request: Request): Promise<ScimPrincipal> {
    const header = request.headers.authorization;
    const token =
      header !== undefined && /^bearer\s+/i.test(header)
        ? header.replace(/^bearer\s+/i, '').trim()
        : undefined;

    const principal = await this.scim.authenticate(token);
    if (!principal) {
      throw new UnauthorizedException('A valid provisioning token is required.');
    }
    return principal;
  }

  /** SCIM pagination is 1-based, and `count` is capped so one request cannot ask for everything. */
  private pageFrom(startIndex?: string, count?: string): { startIndex: number; count: number } {
    const parsedStart = startIndex === undefined ? 1 : Number(startIndex);
    const parsedCount = count === undefined ? 100 : Number(count);

    if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedCount)) {
      throw new BadRequestException('startIndex and count must be numbers.');
    }

    return {
      startIndex: Math.max(Math.trunc(parsedStart), 1),
      count: Math.min(Math.max(Math.trunc(parsedCount), 0), 500),
    };
  }

  /**
   * Parse a filter, or refuse it.
   *
   * Refusing an unsupported filter is the whole point: answering it as "no filter" would return
   * every user where the connector asked for one, and it would read that as "this address does
   * not exist yet" and create a duplicate.
   */
  private filterFrom(filter?: string): { filterAttribute?: string; filterValue?: string } {
    if (filter === undefined || filter.trim() === '') {
      return {};
    }

    const parsed = parseEqualityFilter(filter);
    if (!parsed) {
      throw new BadRequestException(
        'This server supports only simple equality filters, e.g. userName eq "a@b.com".',
      );
    }

    return { filterAttribute: parsed.attribute, filterValue: parsed.value };
  }

  private base(path: string): string {
    return `${this.config.publicApiBaseUrl}/scim/v2/${path}`;
  }
}

function operationsFrom(body: { Operations?: ScimPatchOperation[] }): ScimPatchOperation[] {
  const operations = body.Operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new BadRequestException('A PATCH request must carry a non-empty Operations array.');
  }
  return operations;
}

function attribute(
  name: string,
  type: string,
  options: {
    required?: boolean;
    multiValued?: boolean;
    uniqueness?: string;
    mutability?: string;
  } = {},
) {
  return {
    name,
    type,
    multiValued: options.multiValued ?? false,
    required: options.required ?? false,
    caseExact: false,
    mutability: options.mutability ?? 'readWrite',
    returned: 'default',
    uniqueness: options.uniqueness ?? 'none',
  };
}
