const { version } = require('../package.json');

class ResponseUtils {
    static createBaseResponse(success, statusCode = 200) {
        return {
            success,
            timestamp: new Date().toISOString(),
            version
        };
    }

    static createSuccessResponse(data = {}, meta = {}, statusCode = 200) {
        return {
            ...this.createBaseResponse(true, statusCode),
            ...data,
            ...meta
        };
    }

    static createErrorResponse(error, req, statusCode) {
        const response = {
            ...this.createBaseResponse(false, statusCode || error.statusCode || 500),
            error: {
                code: error.code || 'UNKNOWN_ERROR',
                message: error.message || 'Error',
                path: req?.originalUrl
            }
        };

        if (process.env.NODE_ENV === 'development' && error.stack) {
            response.error.stack = error.stack;
        }

        if (error.details) {
            response.error.details = error.details;
        }

        return response;
    }

    static sendSuccess(res, data = {}, meta = {}, statusCode = 200) {
        res.status(statusCode).json(this.createSuccessResponse(data, meta, statusCode));
    }

    static sendError(res, error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json(this.createErrorResponse(error, res.req, statusCode));
    }

    static wsSuccess(callback, data = {}, statusCode = 200) {
        const response = this.createSuccessResponse(data, {}, statusCode);
        if (typeof callback === 'function') callback(response);
    }

    static wsError(callback, statusCode, message, error = null) {
        const errorObj = new Error(message);
        errorObj.statusCode = statusCode;
        if (error) errorObj.originalError = error;
        
        const response = this.createErrorResponse(errorObj, null, statusCode);
        if (typeof callback === 'function') callback(response);
    }
}

module.exports = ResponseUtils;