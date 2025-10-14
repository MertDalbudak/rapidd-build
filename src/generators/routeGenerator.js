const fs = require('fs');
const path = require('path');

/**
 * Generate Express route for a single model
 * @param {string} modelName - Name of the model
 * @returns {string} - Generated route code
 */
function generateRouteFile(modelName) {
  const className = modelName.charAt(0).toUpperCase() + modelName.slice(1);

  return `const router = require('express').Router();
const {${className}, QueryBuilder, prisma} = require('../../../src/Model/${className}');

router.all('*', async (req, res, next) => {
    if(req.user){
        req.${className} = new ${className}({'user': req.user});
        next();
    }
    else{
        return res.sendError(401, "no_valid_session");
    }
});

// GET ALL
router.get('/', async function(req, res) {
    try {
        const { q = {}, include = "", limit = 25, offset = 0, sortBy = "id", sortOrder = "asc" } = req.query;
        const results = await req.${className}.getMany(q, include, limit, offset, sortBy, sortOrder);
        return res.sendList(results.data, {'take': req.${className}.take(Number(limit)), 'skip': req.${className}.skip(Number(offset)), 'total': results.total});
    }
    catch(error){
        const response = QueryBuilder.errorHandler(error);
        return res.status(response.status_code).send(response);
    }
});

// GET BY ID
router.get('/:id', async function(req, res) {
    try{
        const { include = ""} = req.query;
        const response = await req.${className}.get(req.params.id, include);
        return res.json(response);
    }
    catch(error){
        const response = QueryBuilder.errorHandler(error);
        return res.status(response.status_code).send(response);
    }
});

// CREATE
router.post('/', async function(req, res) {
    const payload = req.body;
    try{
        const response = await req.${className}.create(payload);
        return res.status(201).json(response);
    }
    catch(error){
        const response = QueryBuilder.errorHandler(error, payload);
        return res.status(response.status_code).send(response);
    }
});

// UPDATE
router.patch('/:id', async function(req, res) {
    const payload = req.body;
    try{
        const response = await req.${className}.update(req.params.id, payload);
        return res.json(response);
    }
    catch(error){
        const response = QueryBuilder.errorHandler(error, payload);
        return res.status(response.status_code).send(response);
    }
});

// DELETE
router.delete('/:id', async (req, res)=>{
    try{
        await req.${className}.delete(req.params.id);
        return res.sendResponse(200, "object_deleted_successfully", {modelName: "${className}"});
    }
    catch(error){
        const response = QueryBuilder.errorHandler(error);
        return res.status(response.status_code).send(response);
    }
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
