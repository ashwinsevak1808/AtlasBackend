import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { type Application, type Request, type Response } from 'express';
import { config } from './env.js';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Atlas Backend API Specification',
      version: '1.0.0',
      description: 'Interactive OpenAPI/Swagger documentation for Atlas Backend REST endpoints.',
      contact: {
        name: 'Atlas Engineering Team',
        url: 'https://getatlas.space',
      },
    },
    servers: [
      {
        url: `http://localhost:${config.poolMax ? process.env.PORT || 5005 : 5005}`,
        description: 'Local Development Server',
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Pass session token in Authorization header: Bearer <token>',
        },
        InternalKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-atlas-key',
          description: 'Internal API secret key required when INTERNAL_API_KEY is configured.',
        },
      },
    },
    paths: {
      '/health': {
        get: {
          summary: 'Health Check Probe',
          description: 'Returns server operational status for Cloud Run or local probes.',
          tags: ['Health'],
          responses: {
            '200': {
              description: 'Server is healthy',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', example: 'ok' },
                      message: { type: 'string', example: 'Atlas Backend API Server Running' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/auth/register': {
        post: {
          summary: 'Register New Account',
          description: 'Creates a new user account and dispatches an OTP verification code.',
          tags: ['Authentication'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password', 'confirmPassword'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'dev@getatlas.space' },
                    password: { type: 'string', minLength: 8, example: 'SuperSecret123!' },
                    confirmPassword: { type: 'string', example: 'SuperSecret123!' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Account created & verification code dispatched',
            },
            '400': { description: 'Validation failure' },
          },
        },
      },
      '/api/auth/login': {
        post: {
          summary: 'User Login',
          description: 'Authenticates user with email and password.',
          tags: ['Authentication'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'dev@getatlas.space' },
                    password: { type: 'string', example: 'SuperSecret123!' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Login successful' },
            '401': { description: 'Invalid credentials' },
          },
        },
      },
      '/api/auth/me': {
        get: {
          summary: 'Get Current Authenticated User Profile',
          tags: ['Authentication'],
          security: [{ BearerAuth: [] }],
          responses: {
            '200': { description: 'Current user profile data' },
            '401': { description: 'Unauthorized / Missing or invalid token' },
          },
        },
      },
    },
  },
  apis: ['./src/modules/**/*.routes.ts', './src/routes/*.ts'],
};

const swaggerSpec = swaggerJsdoc(options);

export function setupSwagger(app: Application): void {
  // Serve Swagger UI documentation web interface at /api-docs
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  // Serve raw OpenAPI JSON spec at /api-docs.json
  app.get('/api-docs.json', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}
