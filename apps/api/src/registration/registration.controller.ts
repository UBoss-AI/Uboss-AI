import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

import { AllowAnonymous } from '../tenancy/tenancy.decorators.js';
import { SelfServeRegistrationService } from './self-serve-registration.service.js';

export class StartRegistrationDto {
  /*
   * Four fields, and that is the whole form.
   *
   * There is deliberately **no plan**, no seat count and no allowance. Those are decided by the
   * handler from the Pilot plan row, and a field for any of them here would be a field somebody
   * could post a different value into — which on a public endpoint means provisioning themselves
   * a paid tier. What cannot be sent cannot be forged.
   *
   * There are also no onboarding questions. They existed to choose an example-data pack, the
   * Pilot has no example data, and a question that serves nothing is just a reason to abandon
   * a form.
   */
  @IsEmail({}, { message: 'Enter a work email address.' })
  @MaxLength(320)
  workEmail!: string;

  @IsString()
  @IsNotEmpty({ message: 'Enter your name.' })
  @MinLength(2)
  @MaxLength(200)
  fullName!: string;

  @IsString()
  @IsNotEmpty({ message: 'Enter your company’s name.' })
  @MinLength(2)
  @MaxLength(200)
  companyName!: string;

  @IsString()
  @IsNotEmpty({ message: 'Enter your company’s domain.' })
  @MaxLength(253)
  domain!: string;
}

/**
 * Signing a company up, from the outside.
 *
 * ## Why these routes are anonymous, and why that is not a hole
 *
 * Whoever is signing up has no account and belongs to no company — there is nothing to
 * authenticate them as, which is the entire point of a self-serve signup. So `@AllowAnonymous`
 * is correct here, and what takes the place of authentication is three things:
 *
 *   * **Two proofs before anything is created.** A link to the address, then a DNS record on the
 *     domain. The company is created last, after both.
 *   * **A token on every step after the form.** The id in the URL is not a secret; the token that
 *     went to the inbox is, and nothing can be reached without it.
 *   * **Limits that key on the subject, not the caller.** Per domain, per address, and a ceiling
 *     across the platform — because the generic rate limiter keys on identity and deliberately
 *     treats anonymous traffic as the proxy's problem.
 *
 * ## Why the form's answer says nothing
 *
 * It returns an id and no more. A different answer for an address already in use would turn this
 * into a way of asking "does this person work at this company", which an anonymous caller should
 * not be able to put to a product that knows.
 */
@Controller('register')
export class RegistrationController {
  constructor(private readonly registration: SelfServeRegistrationService) {}

  @Post()
  @AllowAnonymous()
  async start(@Body() body: StartRegistrationDto, @Req() request: Request): Promise<unknown> {
    return this.registration.start({
      workEmail: body.workEmail,
      fullName: body.fullName,
      companyName: body.companyName,
      domain: body.domain,
      /*
       * Reduced to a /16 before it is stored, and used for nothing but investigation.
       *
       * Not a control: `X-Forwarded-For` is set by whatever sits in front of this application and
       * can be forged when nothing does, so a limit keyed on it would have a strength this code
       * cannot verify. The limits are on the domain and the address instead.
       */
      ...(request.ip === undefined ? {} : { clientAddress: request.ip }),
    });
  }

  /** The link from the inbox. Proves the address, and hands back the DNS record to publish. */
  @Post(':id/confirm')
  @AllowAnonymous()
  async confirm(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('token') token: string,
  ): Promise<unknown> {
    return this.registration.confirmEmail(id, token ?? '');
  }

  /** Look for the DNS record. Creates the company the moment it is found. */
  @Post(':id/domain-check')
  @AllowAnonymous()
  async checkDomain(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('token') token: string,
  ): Promise<unknown> {
    return this.registration.checkDomain(id, token ?? '');
  }

  /** Where this signup has got to, so the page can be reloaded without losing the thread. */
  @Get(':id')
  @AllowAnonymous()
  async status(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('token') token: string,
  ): Promise<unknown> {
    return this.registration.status(id, token ?? '');
  }
}
