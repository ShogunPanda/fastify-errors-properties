import { FastifyInstance, FastifyRequest, RouteOptions, ValidationResult } from 'fastify'
import createError from 'http-errors'
import { INTERNAL_SERVER_ERROR } from 'http-status-codes'
import {
  FastifyDecoratedInstance,
  FastifyDecoratedReply,
  RequestSection,
  ResponseSchemas,
  ValidationFormatter,
  Validations
} from './interfaces'
import get = require('lodash.get')

export function niceJoin(array: Array<string>, lastSeparator: string = ' and ', separator: string = ', '): string {
  switch (array.length) {
    case 0:
      return ''
    case 1:
      return array[0]
    case 2:
      return array.join(lastSeparator)
    default:
      return array.slice(0, array.length - 1).join(separator) + lastSeparator + array[array.length - 1]
  }
}

export const validationMessagesFormatters: { [key: string]: ValidationFormatter } = {
  contentType: () =>
    'only JSON payloads are accepted. Please set the "Content-Type" header to start with "application/json"',
  json: () => 'the body payload is not a valid JSON',
  jsonEmpty: () => 'the JSON body payload cannot be empty if the "Content-Type" header is set',
  missing: () => 'must be present',
  unknown: () => 'is not a valid property',
  uuid: () => 'must be a valid GUID (UUID v4)',
  timestamp: () => 'must be a valid ISO 8601 / RFC 3339 timestamp (example: 2018-07-06T12:34:56Z)',
  date: () => 'must be a valid ISO 8601 / RFC 3339 date (example: 2018-07-06)',
  time: () => 'must be a valid ISO 8601 / RFC 3339 time (example: 12:34:56)',
  hostname: () => 'must be a valid hostname',
  ipv4: () => 'must be a valid IPv4',
  ipv6: () => 'must be a valid IPv6',
  paramType: (type: string) => {
    switch (type) {
      case 'integer':
        return 'must be a valid integer number'
      case 'number':
        return 'must be a valid number'
      case 'boolean':
        return 'must be a valid boolean (true or false)'
      case 'object':
        return 'must be a object'
      case 'array':
        return 'must be an array'
      default:
        return 'must be a string'
    }
  },
  presentString: () => 'must be a non empty string',
  minimum: (min: number) => `must be a number greater than or equal to ${min}`,
  maximum: (max: number) => `must be a number less than or equal to ${max}`,
  minimumProperties(min: number): string {
    return min === 1 ? 'cannot be a empty object' : `must be a object with at least ${min} properties`
  },
  maximumProperties(max: number): string {
    return max === 0 ? 'must be a empty object' : `must be a object with at most ${max} properties`
  },
  minimumItems(min: number): string {
    return min === 1 ? 'cannot be a empty array' : `must be an array with at least ${min} items`
  },
  maximumItems(max: number): string {
    return max === 0 ? 'must be a empty array' : `must be an array with at most ${max} items`
  },
  enum: (values: Array<string>) =>
    `must be one of the following values: ${niceJoin(
      values.map((f: string) => `"${f}"`),
      ' or '
    )}`,
  pattern: (pattern: string) => `must match pattern "${pattern.replace(/\(\?\:/g, '(')}"`,
  invalidResponseCode: (code: number) => `This endpoint cannot respond with HTTP status ${code}.`,
  invalidResponse: (code: number) =>
    `The response returned from the endpoint violates its specification for the HTTP status ${code}.`,
  invalidFormat: (format: string) => `must match format "${format}" (format)`
}

export function convertValidationErrors(
  section: RequestSection,
  data: { [key: string]: unknown },
  validationErrors: Array<ValidationResult>
): Validations {
  const errors: { [key: string]: string } = {}

  if (section === 'querystring') {
    section = 'query'
  }

  // For each error
  for (const e of validationErrors) {
    let message = ''

    // Normalize the key
    let key = e.dataPath

    if (key.startsWith('.')) {
      key = key.substring(1)
    }

    if (key.startsWith('[') && key.endsWith(']')) {
      key = key.substring(1, key.length - 1)
    }

    // Depending on the type
    switch (e.keyword) {
      case 'required':
      case 'dependencies':
        key = e.params.missingProperty
        message = validationMessagesFormatters.missing()
        break
      case 'additionalProperties':
        key = e.params.additionalProperty

        message = validationMessagesFormatters.unknown()
        break
      case 'type':
        message = validationMessagesFormatters.paramType(e.params.type)
        break
      case 'minProperties':
        message = validationMessagesFormatters.minimumProperties(e.params.limit)
        break
      case 'maxProperties':
        message = validationMessagesFormatters.maximumProperties(e.params.limit)
        break
      case 'minItems':
        message = validationMessagesFormatters.minimumItems(e.params.limit)
        break
      case 'maxItems':
        message = validationMessagesFormatters.maximumItems(e.params.limit)
        break
      case 'minimum':
        message = validationMessagesFormatters.minimum(e.params.limit)
        break
      case 'maximum':
        message = validationMessagesFormatters.maximum(e.params.limit)
        break
      case 'enum':
        message = validationMessagesFormatters.enum(e.params.allowedValues)
        break
      case 'pattern':
        const pattern = e.params.pattern
        const value = get(data, key) as string

        if (pattern === '.+' && !value) {
          message = validationMessagesFormatters.presentString()
        } else {
          message = validationMessagesFormatters.pattern(e.params.pattern)
        }

        break
      case 'format':
        let reason = e.params.format

        // Normalize the key
        if (reason === 'date-time') {
          reason = 'timestamp'
        }

        message = (validationMessagesFormatters[reason] || validationMessagesFormatters.invalidFormat)(reason)

        break
    }

    // No custom message was found, default to input one replacing the starting verb and adding some path info
    if (!message) {
      message = `${e.message.replace(/^should/, 'must')} (${e.keyword})`
    }

    // Find the property to add
    let property = key
      .replace(/\[(\d+)\]/g, '.$1') // Array path
      .replace(/\[([^\]]+)\]/g, '.$1') // Object path

    // Remove useless quotes
    if (property.match(/(?:^['"])(?:[^\.]+)(?:['"]$)/)) {
      property = property.substring(1, property.length - 1)
    }

    // Fix empty properties
    if (!property) {
      property = '$root'
    }

    errors[property] = message
  }

  return { [section]: errors }
}

export function addResponseValidation(this: FastifyDecoratedInstance, route: RouteOptions): void {
  if (!route.schema?.response) {
    return
  }

  const validators = Object.entries(route.schema.response).reduce<ResponseSchemas>(
    (accu: ResponseSchemas, [code, schema]: [string, object]) => {
      accu[code] = this.responseValidatorSchemaCompiler.compile(schema)

      return accu
    },
    {} as ResponseSchemas
  )

  // Note that this hook is not called for non JSON payloads therefore validation is not possible in such cases
  route.preSerialization = async function(
    this: FastifyInstance,
    _request: FastifyRequest,
    reply: FastifyDecoratedReply,
    payload: any
  ): Promise<any> {
    const statusCode = reply.res.statusCode

    // Never validate error 500
    if (statusCode === INTERNAL_SERVER_ERROR) {
      return payload
    }

    // No validator, it means the HTTP status is not allowed
    const validator = validators[statusCode]

    if (!validator) {
      throw createError(INTERNAL_SERVER_ERROR, validationMessagesFormatters.invalidResponseCode(statusCode))
    }

    // Now validate the payload
    const valid = validator(payload)

    if (!valid) {
      throw createError(INTERNAL_SERVER_ERROR, validationMessagesFormatters.invalidResponse(statusCode), {
        failedValidations: convertValidationErrors('response', payload, validator.errors as Array<ValidationResult>)
      })
    }

    return payload
  }
}
