const fs = require('fs');
const path = require('path');

/**
 * Generate Express route for a single model
 * @param {string} modelName - Name of the model
 * @returns {string} - Generated route code
 */
function generateRouteFile(modelName) {
  const modelNameLower = modelName.toLowerCase();
  const className = modelName.charAt(0).toUpperCase() + modelName.slice(1);

  return `const router = require('express').Router();
const {Api, ErrorResponse} = require('../../../src/Api');
const {${className}, QueryBuilder, prisma} = require('../../../src/Model/${className}');

router.all('*', async (req, res, next) => {
    if(req.session && req.user){
        req.${className} = new ${className}({'user': req.user});
        next();
    }
    else{
        res.status(401).send({'status_code': res.statusCode, 'message': "No valid session"});
    }
});

// GET ALL
router.get('/', async function(req, res) {
    let response, status_code = 200;
    try {
        const { q = {}, include = "", limit = 25, offset = 0, sortBy = "id", sortOrder = "asc" } = req.query;

        const _data = req.${className}.getMany(q, include, limit, offset, sortBy, sortOrder);
        const _count = req.${className}.count(q);
        const [data, count] = await Promise.all([_data, _count]);

        response = Api.getListResponseBody(data, {'take': req.${className}.take(Number(limit)), 'skip': req.${className}.skip(Number(offset)), 'total': count});
    }
    catch(error){
        response = QueryBuilder.errorHandler(error);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});

// GET BY ID
router.get('/:id', async function(req, res) {
    let response, status_code = 200;
    try{
        const { include = ""} = req.query;
        response = await req.${className}.get(req.params.id, include);
    }
    catch(error){
        response = QueryBuilder.errorHandler(error);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});

// CREATE
router.post('/', async function(req, res) {
    let response, status_code = 201, payload = req.body;
    try{
        response = await req.${className}.create(payload);
    }
    catch(error){
        response = QueryBuilder.errorHandler(error, payload);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});

// UPDATE
router.patch('/:id', async function(req, res) {
    let response, status_code = 200, payload = req.body;
    try{
        response = await req.${className}.update(req.params.id, payload);
    }
    catch(error){
        response = QueryBuilder.errorHandler(error, payload);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});

// DELETE
router.delete('/:id', async (req, res)=>{
    let response, status_code = 200;
    try{
        await req.${className}.delete(req.params.id);
        response = {'status_code': status_code, 'message': "${className} successfully deleted"}
    }
    catch(error){
        response = QueryBuilder.errorHandler(error);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});

module.exports = router;
`;
}

/**
 * Generate all route files
 * @param {Object} models - Models object from parser
 * @param {string} routesDir - Directory to output route files
 */
function generateAllRoutes(models, routesDir) {
  // Create routes directory if it doesn't exist
  if (!fs.existsSync(routesDir)) {
    fs.mkdirSync(routesDir, { recursive: true });
  }

  // Generate individual route files
  for (const modelName of Object.keys(models)) {
    const routeCode = generateRouteFile(modelName);
    const routePath = path.join(routesDir, `${modelName.toLowerCase()}.js`);
    fs.writeFileSync(routePath, routeCode);
    console.log(`Generated route: ${modelName.toLowerCase()}.js`);
  }
}

module.exports = {
  generateAllRoutes,
  generateRouteFile
};
