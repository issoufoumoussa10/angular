/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

/// <reference types="node" />

import * as os from 'os';

import {AbsoluteFsPath, FileSystem, absoluteFrom, getFileSystem, join} from '../../../src/ngtsc/file_system';
import {Folder, MockFileSystem, TestFile, runInEachFileSystem} from '../../../src/ngtsc/file_system/testing';
import {loadStandardTestFiles, loadTestFiles} from '../../../test/helpers';
import {mainNgcc} from '../../src/main';
import {markAsProcessed} from '../../src/packages/build_marker';
import {EntryPointJsonProperty, EntryPointPackageJson, SUPPORTED_FORMAT_PROPERTIES} from '../../src/packages/entry_point';
import {Transformer} from '../../src/packages/transformer';
import {DirectPackageJsonUpdater, PackageJsonUpdater} from '../../src/writing/package_json_updater';
import {MockLogger} from '../helpers/mock_logger';
import {compileIntoApf, compileIntoFlatEs5Package} from './util';


const testFiles = loadStandardTestFiles({fakeCore: false, rxjs: true});

runInEachFileSystem(() => {
  describe('ngcc main()', () => {
    let _: typeof absoluteFrom;
    let fs: FileSystem;
    let pkgJsonUpdater: PackageJsonUpdater;

    beforeEach(() => {
      _ = absoluteFrom;
      fs = getFileSystem();
      pkgJsonUpdater = new DirectPackageJsonUpdater(fs);
      initMockFileSystem(fs, testFiles);

      // Force single-process execution in unit tests by mocking available CPUs to 1.
      spyOn(os, 'cpus').and.returnValue([{model: 'Mock CPU'}]);
    });

    it('should run ngcc without errors for esm2015', () => {
      expect(() => mainNgcc({basePath: '/node_modules', propertiesToConsider: ['esm2015']}))
          .not.toThrow();
    });

    it('should run ngcc without errors for esm5', () => {
      expect(() => mainNgcc({
               basePath: '/node_modules',
               propertiesToConsider: ['esm5'],
               logger: new MockLogger(),
             }))
          .not.toThrow();
    });

    it('should run ngcc without errors when "main" property is not present', () => {
      mainNgcc({
        basePath: '/dist',
        propertiesToConsider: ['main', 'es2015'],
        logger: new MockLogger(),
      });

      expect(loadPackage('local-package', _('/dist')).__processed_by_ivy_ngcc__).toEqual({
        es2015: '0.0.0-PLACEHOLDER',
        typings: '0.0.0-PLACEHOLDER',
      });
    });

    it('should throw, if some of the entry-points are unprocessable', () => {
      const createEntryPoint = (name: string, prop: EntryPointJsonProperty): TestFile[] => {
        return [
          {
            name: _(`/dist/${name}/package.json`),
            contents: `{"name": "${name}", "typings": "./index.d.ts", "${prop}": "./index.js"}`,
          },
          {name: _(`/dist/${name}/index.js`), contents: 'var DUMMY_DATA = true;'},
          {name: _(`/dist/${name}/index.d.ts`), contents: 'export type DummyData = boolean;'},
          {name: _(`/dist/${name}/index.metadata.json`), contents: 'DUMMY DATA'},
        ];
      };

      loadTestFiles([
        ...createEntryPoint('processable-1', 'es2015'),
        ...createEntryPoint('unprocessable-2', 'main'),
        ...createEntryPoint('unprocessable-3', 'main'),
      ]);

      expect(() => mainNgcc({
               basePath: '/dist',
               propertiesToConsider: ['es2015', 'fesm5', 'module'],
               logger: new MockLogger(),
             }))
          .toThrowError(
              'Unable to process any formats for the following entry-points (tried es2015, fesm5, module): \n' +
              `  - ${_('/dist/unprocessable-2')}\n` +
              `  - ${_('/dist/unprocessable-3')}`);
    });

    it('should throw, if an error happens during processing', () => {
      spyOn(Transformer.prototype, 'transform').and.throwError('Test error.');

      expect(() => mainNgcc({
               basePath: '/dist',
               targetEntryPointPath: 'local-package',
               propertiesToConsider: ['main', 'es2015'],
               logger: new MockLogger(),
             }))
          .toThrowError(`Test error.`);

      expect(loadPackage('@angular/core').__processed_by_ivy_ngcc__).toBeUndefined();
      expect(loadPackage('local-package', _('/dist')).__processed_by_ivy_ngcc__).toBeUndefined();
    });

    it('should generate correct metadata for decorated getter/setter properties', () => {
      compileIntoFlatEs5Package('test-package', {
        '/index.ts': `
          import {Directive, Input, NgModule} from '@angular/core';
  
          @Directive({selector: '[foo]'})
          export class FooDirective {
            @Input() get bar() { return 'bar'; }
            set bar(value: string) {}
          }
  
          @NgModule({
            declarations: [FooDirective],
          })
          export class FooModule {}
        `,
      });

      mainNgcc({
        basePath: '/node_modules',
        targetEntryPointPath: 'test-package',
        propertiesToConsider: ['main'],
      });

      const jsContents = fs.readFile(_(`/node_modules/test-package/index.js`)).replace(/\s+/g, ' ');
      expect(jsContents)
          .toContain(
              '/*@__PURE__*/ (function () { ɵngcc0.ɵsetClassMetadata(FooDirective, ' +
              '[{ type: Directive, args: [{ selector: \'[foo]\' }] }], ' +
              'function () { return []; }, ' +
              '{ bar: [{ type: Input }] }); })();');
    });

    it('should not add `const` in ES5 generated code', () => {
      compileIntoFlatEs5Package('test-package', {
        '/index.ts': `
          import {Directive, Input, NgModule} from '@angular/core';
  
          @Directive({
            selector: '[foo]',
            host: {bar: ''},
          })
          export class FooDirective {
          }
  
          @NgModule({
            declarations: [FooDirective],
          })
          export class FooModule {}
        `,
      });

      mainNgcc({
        basePath: '/node_modules',
        targetEntryPointPath: 'test-package',
        propertiesToConsider: ['main'],
      });

      const jsContents = fs.readFile(_(`/node_modules/test-package/index.js`));
      expect(jsContents).not.toMatch(/\bconst \w+\s*=/);
      expect(jsContents).toMatch(/\bvar _c0 =/);
    });

    it('should add ɵfac but not duplicate ɵprov properties on injectables', () => {
      compileIntoFlatEs5Package('test-package', {
        '/index.ts': `
        import {Injectable, ɵɵdefineInjectable} from '@angular/core';
        export const TestClassToken = 'TestClassToken';
        @Injectable({providedIn: 'module'})
        export class TestClass {
          static ɵprov = ɵɵdefineInjectable({ factory: () => {}, token: TestClassToken, providedIn: "module" });
        }
        `,
      });

      const before = fs.readFile(_(`/node_modules/test-package/index.js`));
      const originalProp = /ɵprov[^;]+/.exec(before) ![0];
      mainNgcc({
        basePath: '/node_modules',
        targetEntryPointPath: 'test-package',
        propertiesToConsider: ['main'],
      });
      const after = fs.readFile(_(`/node_modules/test-package/index.js`));

      expect(before).toContain(originalProp);
      expect(countOccurrences(before, 'ɵprov')).toEqual(1);
      expect(countOccurrences(before, 'ɵfac')).toEqual(0);

      expect(after).toContain(originalProp);
      expect(countOccurrences(after, 'ɵprov')).toEqual(1);
      expect(countOccurrences(after, 'ɵfac')).toEqual(1);
    });

    // This is necessary to ensure XPipeDef.fac is defined when delegated from injectable def
    it('should always generate factory def (fac) before injectable def (prov)', () => {
      compileIntoFlatEs5Package('test-package', {
        '/index.ts': `
        import {Injectable, Pipe, PipeTransform} from '@angular/core';
       
        @Injectable()
        @Pipe({
          name: 'myTestPipe'
        })
        export class TestClass implements PipeTransform {
          transform(value: any) { return value; }
        }
        `,
      });

      mainNgcc({
        basePath: '/node_modules',
        targetEntryPointPath: 'test-package',
        propertiesToConsider: ['main'],
      });

      const jsContents = fs.readFile(_(`/node_modules/test-package/index.js`));
      expect(jsContents)
          .toContain(
              `TestClass.ɵfac = function TestClass_Factory(t) { return new (t || TestClass)(); };\n` +
              `TestClass.ɵpipe = ɵngcc0.ɵɵdefinePipe({ name: "myTestPipe", type: TestClass, pure: true });\n` +
              `TestClass.ɵprov = ɵngcc0.ɵɵdefineInjectable({`);
    });

    it('should add generic type for ModuleWithProviders and generate exports for private modules',
       () => {
         compileIntoApf('test-package', {
           '/index.ts': `
              import {ModuleWithProviders} from '@angular/core';
              import {InternalFooModule} from './internal';

              export class FooModule {
                static forRoot(): ModuleWithProviders {
                  return {
                    ngModule: InternalFooModule,
                  };
                }
              }
            `,
           '/internal.ts': `
              import {NgModule} from '@angular/core';

              @NgModule()
              export class InternalFooModule {}
           `,
         });

         mainNgcc({
           basePath: '/node_modules',
           targetEntryPointPath: 'test-package',
           propertiesToConsider: ['esm2015', 'esm5', 'module'],
         });

         // The .d.ts where FooModule is declared should have a generic type added
         const dtsContents = fs.readFile(_(`/node_modules/test-package/src/index.d.ts`));
         expect(dtsContents).toContain(`import * as ɵngcc0 from './internal';`);
         expect(dtsContents)
             .toContain(`static forRoot(): ModuleWithProviders<ɵngcc0.InternalFooModule>`);

         // The public facing .d.ts should export the InternalFooModule
         const entryDtsContents = fs.readFile(_(`/node_modules/test-package/index.d.ts`));
         expect(entryDtsContents).toContain(`export {InternalFooModule} from './src/internal';`);

         // The esm2015 index source should export the InternalFooModule
         const esm2015Contents = fs.readFile(_(`/node_modules/test-package/esm2015/index.js`));
         expect(esm2015Contents).toContain(`export {InternalFooModule} from './src/internal';`);

         // The esm5 index source should also export the InternalFooModule
         const esm5Contents = fs.readFile(_(`/node_modules/test-package/esm5/index.js`));
         expect(esm5Contents).toContain(`export {InternalFooModule} from './src/internal';`);
       });

    it('should use `$localize` calls rather than tagged templates in ES5 generated code', () => {
      compileIntoFlatEs5Package('test-package', {
        '/index.ts': `
        import {Component, Input, NgModule} from '@angular/core';

        @Component({
          selector: '[foo]',
          template: '<div i18n="some:\`description\`">A message</div>'
        })
        export class FooComponent {
        }

        @NgModule({
          declarations: [FooComponent],
        })
        export class FooModule {}
      `,
      });

      mainNgcc({
        basePath: '/node_modules',
        targetEntryPointPath: 'test-package',
        propertiesToConsider: ['main'],
      });

      const jsContents = fs.readFile(_(`/node_modules/test-package/index.js`));
      expect(jsContents).not.toMatch(/\$localize\s*`/);
      expect(jsContents)
          .toMatch(
              /\$localize\(ɵngcc\d+\.__makeTemplateObject\(\[":some:`description`:A message"], \[":some\\\\:\\\\`description\\\\`:A message"]\)\);/);
    });

    describe('in async mode', () => {
      it('should run ngcc without errors for fesm2015', async() => {
        const promise = mainNgcc({
          basePath: '/node_modules',
          propertiesToConsider: ['fesm2015'],
          async: true,
        });

        expect(promise).toEqual(jasmine.any(Promise));
        await promise;
      });

      it('should reject, if some of the entry-points are unprocessable', async() => {
        const createEntryPoint = (name: string, prop: EntryPointJsonProperty): TestFile[] => {
          return [
            {
              name: _(`/dist/${name}/package.json`),
              contents: `{"name": "${name}", "typings": "./index.d.ts", "${prop}": "./index.js"}`,
            },
            {name: _(`/dist/${name}/index.js`), contents: 'var DUMMY_DATA = true;'},
            {name: _(`/dist/${name}/index.d.ts`), contents: 'export type DummyData = boolean;'},
            {name: _(`/dist/${name}/index.metadata.json`), contents: 'DUMMY DATA'},
          ];
        };

        loadTestFiles([
          ...createEntryPoint('processable-1', 'es2015'),
          ...createEntryPoint('unprocessable-2', 'main'),
          ...createEntryPoint('unprocessable-3', 'main'),
        ]);

        const promise = mainNgcc({
          basePath: '/dist',
          propertiesToConsider: ['es2015', 'fesm5', 'module'],
          logger: new MockLogger(),
          async: true,
        });

        await promise.then(
            () => Promise.reject('Expected promise to be rejected.'),
            err => expect(err).toEqual(new Error(
                'Unable to process any formats for the following entry-points (tried es2015, fesm5, module): \n' +
                `  - ${_('/dist/unprocessable-2')}\n` +
                `  - ${_('/dist/unprocessable-3')}`)));
      });

      it('should reject, if an error happens during processing', async() => {
        spyOn(Transformer.prototype, 'transform').and.throwError('Test error.');

        const promise = mainNgcc({
          basePath: '/dist',
          targetEntryPointPath: 'local-package',
          propertiesToConsider: ['main', 'es2015'],
          logger: new MockLogger(),
          async: true,
        });

        await promise.then(
            () => Promise.reject('Expected promise to be rejected.'),
            err => expect(err).toEqual(new Error('Test error.')));

        expect(loadPackage('@angular/core').__processed_by_ivy_ngcc__).toBeUndefined();
        expect(loadPackage('local-package', _('/dist')).__processed_by_ivy_ngcc__).toBeUndefined();
      });
    });

    describe('with targetEntryPointPath', () => {
      it('should only compile the given package entry-point (and its dependencies).', () => {
        const STANDARD_MARKERS = {
          main: '0.0.0-PLACEHOLDER',
          module: '0.0.0-PLACEHOLDER',
          es2015: '0.0.0-PLACEHOLDER',
          esm5: '0.0.0-PLACEHOLDER',
          esm2015: '0.0.0-PLACEHOLDER',
          fesm5: '0.0.0-PLACEHOLDER',
          fesm2015: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        };

        mainNgcc({basePath: '/node_modules', targetEntryPointPath: '@angular/common/http/testing'});
        expect(loadPackage('@angular/common/http/testing').__processed_by_ivy_ngcc__)
            .toEqual(STANDARD_MARKERS);
        // * `common/http` is a dependency of `common/http/testing`, so is compiled.
        expect(loadPackage('@angular/common/http').__processed_by_ivy_ngcc__)
            .toEqual(STANDARD_MARKERS);
        // * `core` is a dependency of `common/http`, so is compiled.
        expect(loadPackage('@angular/core').__processed_by_ivy_ngcc__).toEqual(STANDARD_MARKERS);
        // * `common` is a private (only in .js not .d.ts) dependency so is compiled.
        expect(loadPackage('@angular/common').__processed_by_ivy_ngcc__).toEqual(STANDARD_MARKERS);
        // * `common/testing` is not a dependency so is not compiled.
        expect(loadPackage('@angular/common/testing').__processed_by_ivy_ngcc__).toBeUndefined();
      });

      it('should mark a non-Angular package target as processed', () => {
        mainNgcc({basePath: '/node_modules', targetEntryPointPath: 'test-package'});

        // `test-package` has no Angular but is marked as processed.
        expect(loadPackage('test-package').__processed_by_ivy_ngcc__).toEqual({
          es2015: '0.0.0-PLACEHOLDER',
          esm2015: '0.0.0-PLACEHOLDER',
          esm5: '0.0.0-PLACEHOLDER',
          fesm2015: '0.0.0-PLACEHOLDER',
          fesm5: '0.0.0-PLACEHOLDER',
          main: '0.0.0-PLACEHOLDER',
          module: '0.0.0-PLACEHOLDER',
        });

        // * `core` is a dependency of `test-package`, but it is not processed, since test-package
        // was not processed.
        expect(loadPackage('@angular/core').__processed_by_ivy_ngcc__).toBeUndefined();
      });

      it('should report an error if a dependency of the target does not exist', () => {
        expect(() => {
          mainNgcc({basePath: '/node_modules', targetEntryPointPath: 'invalid-package'});
        })
            .toThrowError(
                'The target entry-point "invalid-package" has missing dependencies:\n - @angular/missing\n');
      });
    });

    describe('early skipping of target entry-point', () => {
      describe('[compileAllFormats === true]', () => {
        it('should skip all processing if all the properties are marked as processed', () => {
          const logger = new MockLogger();
          markPropertiesAsProcessed('@angular/common/http/testing', SUPPORTED_FORMAT_PROPERTIES);
          mainNgcc({
            basePath: '/node_modules',
            targetEntryPointPath: '@angular/common/http/testing', logger,
          });
          expect(logger.logs.debug).toContain([
            'The target entry-point has already been processed'
          ]);
        });

        it('should process the target if any `propertyToConsider` is not marked as processed',
           () => {
             const logger = new MockLogger();
             markPropertiesAsProcessed('@angular/common/http/testing', ['esm2015', 'fesm2015']);
             mainNgcc({
               basePath: '/node_modules',
               targetEntryPointPath: '@angular/common/http/testing',
               propertiesToConsider: ['fesm2015', 'esm5', 'esm2015'], logger,
             });
             expect(logger.logs.debug).not.toContain([
               'The target entry-point has already been processed'
             ]);
           });
      });

      describe('[compileAllFormats === false]', () => {
        it('should process the target if the first matching `propertyToConsider` is not marked as processed',
           () => {
             const logger = new MockLogger();
             markPropertiesAsProcessed('@angular/common/http/testing', ['esm2015']);
             mainNgcc({
               basePath: '/node_modules',
               targetEntryPointPath: '@angular/common/http/testing',
               propertiesToConsider: ['esm5', 'esm2015'],
               compileAllFormats: false, logger,
             });

             expect(logger.logs.debug).not.toContain([
               'The target entry-point has already been processed'
             ]);
           });

        it('should skip all processing if the first matching `propertyToConsider` is marked as processed',
           () => {
             const logger = new MockLogger();
             markPropertiesAsProcessed('@angular/common/http/testing', ['esm2015']);
             mainNgcc({
               basePath: '/node_modules',
               targetEntryPointPath: '@angular/common/http/testing',
               // Simulate a property that does not exist on the package.json and will be ignored.
               propertiesToConsider: ['missing', 'esm2015', 'esm5'],
               compileAllFormats: false, logger,
             });

             expect(logger.logs.debug).toContain([
               'The target entry-point has already been processed'
             ]);
           });
      });

      it('should skip all processing if the first matching `propertyToConsider` is marked as processed',
         () => {
           const logger = new MockLogger();
           markPropertiesAsProcessed('@angular/common/http/testing', ['esm2015']);
           mainNgcc({
             basePath: '/node_modules',
             targetEntryPointPath: '@angular/common/http/testing',
             // Simulate a property that does not exist on the package.json and will be ignored.
             propertiesToConsider: ['missing', 'esm2015', 'esm5'],
             compileAllFormats: false, logger,
           });

           expect(logger.logs.debug).toContain([
             'The target entry-point has already been processed'
           ]);
         });
    });


    function markPropertiesAsProcessed(packagePath: string, properties: EntryPointJsonProperty[]) {
      const basePath = _('/node_modules');
      const targetPackageJsonPath = join(basePath, packagePath, 'package.json');
      const targetPackage = loadPackage(packagePath);
      markAsProcessed(
          pkgJsonUpdater, targetPackage, targetPackageJsonPath, ['typings', ...properties]);
    }


    describe('with propertiesToConsider', () => {
      it('should complain if none of the properties in the `propertiesToConsider` list is supported',
         () => {
           const propertiesToConsider = ['es1337', 'fesm42'];
           const errorMessage =
               'No supported format property to consider among [es1337, fesm42]. Supported ' +
               'properties: fesm2015, fesm5, es2015, esm2015, esm5, main, module';

           expect(() => mainNgcc({basePath: '/node_modules', propertiesToConsider}))
               .toThrowError(errorMessage);
         });

      it('should only compile the entry-point formats given in the `propertiesToConsider` list',
         () => {
           mainNgcc({
             basePath: '/node_modules',
             propertiesToConsider: ['main', 'esm5', 'module', 'fesm5'],
             logger: new MockLogger(),

           });

           // The ES2015 formats are not compiled as they are not in `propertiesToConsider`.
           expect(loadPackage('@angular/core').__processed_by_ivy_ngcc__).toEqual({
             esm5: '0.0.0-PLACEHOLDER',
             main: '0.0.0-PLACEHOLDER',
             module: '0.0.0-PLACEHOLDER',
             fesm5: '0.0.0-PLACEHOLDER',
             typings: '0.0.0-PLACEHOLDER',
           });
           expect(loadPackage('@angular/common').__processed_by_ivy_ngcc__).toEqual({
             esm5: '0.0.0-PLACEHOLDER',
             main: '0.0.0-PLACEHOLDER',
             module: '0.0.0-PLACEHOLDER',
             fesm5: '0.0.0-PLACEHOLDER',
             typings: '0.0.0-PLACEHOLDER',
           });
           expect(loadPackage('@angular/common/testing').__processed_by_ivy_ngcc__).toEqual({
             esm5: '0.0.0-PLACEHOLDER',
             main: '0.0.0-PLACEHOLDER',
             module: '0.0.0-PLACEHOLDER',
             fesm5: '0.0.0-PLACEHOLDER',
             typings: '0.0.0-PLACEHOLDER',
           });
           expect(loadPackage('@angular/common/http').__processed_by_ivy_ngcc__).toEqual({
             esm5: '0.0.0-PLACEHOLDER',
             main: '0.0.0-PLACEHOLDER',
             module: '0.0.0-PLACEHOLDER',
             fesm5: '0.0.0-PLACEHOLDER',
             typings: '0.0.0-PLACEHOLDER',
           });
         });

      it('should mark all matching properties as processed in order not to compile them on a subsequent run',
         () => {
           const logger = new MockLogger();
           const logs = logger.logs.debug;

           // `fesm2015` and `es2015` map to the same file: `./fesm2015/common.js`
           mainNgcc({
             basePath: '/node_modules/@angular/common',
             propertiesToConsider: ['fesm2015'], logger,
           });

           expect(logs).not.toContain(['Skipping @angular/common : es2015 (already compiled).']);
           expect(loadPackage('@angular/common').__processed_by_ivy_ngcc__).toEqual({
             es2015: '0.0.0-PLACEHOLDER',
             fesm2015: '0.0.0-PLACEHOLDER',
             typings: '0.0.0-PLACEHOLDER',
           });

           // Now, compiling `es2015` should be a no-op.
           mainNgcc({
             basePath: '/node_modules/@angular/common',
             propertiesToConsider: ['es2015'], logger,
           });

           expect(logs).toContain(['Skipping @angular/common : es2015 (already compiled).']);
         });
    });

    describe('with compileAllFormats set to false', () => {
      it('should only compile the first matching format', () => {
        mainNgcc({
          basePath: '/node_modules',
          propertiesToConsider: ['module', 'fesm5', 'esm5'],
          compileAllFormats: false,
          logger: new MockLogger(),
        });
        // * In the Angular packages fesm5 and module have the same underlying format,
        //   so both are marked as compiled.
        // * The `esm5` is not compiled because we stopped after the `fesm5` format.
        expect(loadPackage('@angular/core').__processed_by_ivy_ngcc__).toEqual({
          fesm5: '0.0.0-PLACEHOLDER',
          module: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        });
        expect(loadPackage('@angular/common').__processed_by_ivy_ngcc__).toEqual({
          fesm5: '0.0.0-PLACEHOLDER',
          module: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        });
        expect(loadPackage('@angular/common/testing').__processed_by_ivy_ngcc__).toEqual({
          fesm5: '0.0.0-PLACEHOLDER',
          module: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        });
        expect(loadPackage('@angular/common/http').__processed_by_ivy_ngcc__).toEqual({
          fesm5: '0.0.0-PLACEHOLDER',
          module: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        });
      });

      it('should cope with compiling the same entry-point multiple times with different formats',
         () => {
           mainNgcc({
             basePath: '/node_modules',
             propertiesToConsider: ['module'],
             compileAllFormats: false,
             logger: new MockLogger(),

           });
           expect(loadPackage('@angular/core').__processed_by_ivy_ngcc__).toEqual({
             fesm5: '0.0.0-PLACEHOLDER',
             module: '0.0.0-PLACEHOLDER',
             typings: '0.0.0-PLACEHOLDER',
           });
           // If ngcc tries to write out the typings files again, this will throw an exception.
           mainNgcc({
             basePath: '/node_modules',
             propertiesToConsider: ['esm5'],
             compileAllFormats: false,
             logger: new MockLogger(),
           });
           expect(loadPackage('@angular/core').__processed_by_ivy_ngcc__).toEqual({
             esm5: '0.0.0-PLACEHOLDER',
             fesm5: '0.0.0-PLACEHOLDER',
             module: '0.0.0-PLACEHOLDER',
             typings: '0.0.0-PLACEHOLDER',
           });
         });
    });

    describe('with createNewEntryPointFormats', () => {
      it('should create new files rather than overwriting the originals', () => {
        const ANGULAR_CORE_IMPORT_REGEX = /import \* as ɵngcc\d+ from '@angular\/core';/;
        mainNgcc({
          basePath: '/node_modules',
          createNewEntryPointFormats: true,
          propertiesToConsider: ['esm5'],
          logger: new MockLogger(),

        });

        // Updates the package.json
        expect(loadPackage('@angular/common').esm5).toEqual('./esm5/common.js');
        expect((loadPackage('@angular/common') as any).esm5_ivy_ngcc)
            .toEqual('__ivy_ngcc__/esm5/common.js');

        // Doesn't touch original files
        expect(fs.readFile(_(`/node_modules/@angular/common/esm5/src/common_module.js`)))
            .not.toMatch(ANGULAR_CORE_IMPORT_REGEX);
        // Or create a backup of the original
        expect(
            fs.exists(_(`/node_modules/@angular/common/esm5/src/common_module.js.__ivy_ngcc_bak`)))
            .toBe(false);

        // Creates new files
        expect(
            fs.readFile(_(`/node_modules/@angular/common/__ivy_ngcc__/esm5/src/common_module.js`)))
            .toMatch(ANGULAR_CORE_IMPORT_REGEX);

        // Copies over files (unchanged) that did not need compiling
        expect(fs.exists(_(`/node_modules/@angular/common/__ivy_ngcc__/esm5/src/version.js`)));
        expect(fs.readFile(_(`/node_modules/@angular/common/__ivy_ngcc__/esm5/src/version.js`)))
            .toEqual(fs.readFile(_(`/node_modules/@angular/common/esm5/src/version.js`)));

        // Overwrites .d.ts files (as usual)
        expect(fs.readFile(_(`/node_modules/@angular/common/common.d.ts`)))
            .toMatch(ANGULAR_CORE_IMPORT_REGEX);
        expect(fs.exists(_(`/node_modules/@angular/common/common.d.ts.__ivy_ngcc_bak`))).toBe(true);
      });

      it('should update `package.json` for all matching format properties', () => {
        mainNgcc({
          basePath: '/node_modules/@angular/core',
          createNewEntryPointFormats: true,
          propertiesToConsider: ['fesm2015', 'fesm5'],
        });

        const pkg: any = loadPackage('@angular/core');

        // `es2015` is an alias of `fesm2015`.
        expect(pkg.fesm2015).toEqual('./fesm2015/core.js');
        expect(pkg.es2015).toEqual('./fesm2015/core.js');
        expect(pkg.fesm2015_ivy_ngcc).toEqual('__ivy_ngcc__/fesm2015/core.js');
        expect(pkg.es2015_ivy_ngcc).toEqual('__ivy_ngcc__/fesm2015/core.js');

        // `module` is an alias of `fesm5`.
        expect(pkg.fesm5).toEqual('./fesm5/core.js');
        expect(pkg.module).toEqual('./fesm5/core.js');
        expect(pkg.fesm5_ivy_ngcc).toEqual('__ivy_ngcc__/fesm5/core.js');
        expect(pkg.module_ivy_ngcc).toEqual('__ivy_ngcc__/fesm5/core.js');
      });
    });

    describe('diagnostics', () => {
      it('should fail with formatted diagnostics when an error diagnostic is produced', () => {
        loadTestFiles([
          {
            name: _('/node_modules/fatal-error/package.json'),
            contents: '{"name": "fatal-error", "es2015": "./index.js", "typings": "./index.d.ts"}',
          },
          {name: _('/node_modules/fatal-error/index.metadata.json'), contents: 'DUMMY DATA'},
          {
            name: _('/node_modules/fatal-error/index.js'),
            contents: `
              import {Component} from '@angular/core';
              export class FatalError {}
              FatalError.decorators = [
                {type: Component, args: [{selector: 'fatal-error'}]}
              ];
            `,
          },
          {
            name: _('/node_modules/fatal-error/index.d.ts'),
            contents: `
              export declare class FatalError {}
            `,
          },
        ]);
        expect(() => mainNgcc({
                 basePath: '/node_modules',
                 targetEntryPointPath: 'fatal-error',
                 propertiesToConsider: ['es2015']
               }))
            .toThrowError(
                /^Failed to compile entry-point fatal-error due to compilation errors:\nnode_modules\/fatal-error\/index\.js\(5,17\): error TS-992001: component is missing a template\r?\n$/);
      });
    });

    describe('logger', () => {
      it('should log info message to the console by default', () => {
        const consoleInfoSpy = spyOn(console, 'info');
        mainNgcc({basePath: '/node_modules', propertiesToConsider: ['esm2015']});
        expect(consoleInfoSpy)
            .toHaveBeenCalledWith('Compiling @angular/common/http : esm2015 as esm2015');
      });

      it('should use a custom logger if provided', () => {
        const logger = new MockLogger();
        mainNgcc({
          basePath: '/node_modules',
          propertiesToConsider: ['esm2015'], logger,
        });
        expect(logger.logs.info).toContain(['Compiling @angular/common/http : esm2015 as esm2015']);
      });
    });

    describe('with pathMappings', () => {
      it('should find and compile packages accessible via the pathMappings', () => {
        mainNgcc({
          basePath: '/node_modules',
          propertiesToConsider: ['es2015'],
          pathMappings: {paths: {'*': ['dist/*']}, baseUrl: '/'},
        });
        expect(loadPackage('@angular/core').__processed_by_ivy_ngcc__).toEqual({
          es2015: '0.0.0-PLACEHOLDER',
          fesm2015: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        });
        expect(loadPackage('local-package', _('/dist')).__processed_by_ivy_ngcc__).toEqual({
          es2015: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        });
      });
    });

    describe('with configuration files', () => {
      it('should process a configured deep-import as an entry-point', () => {
        loadTestFiles([
          {
            name: _('/ngcc.config.js'),
            contents: `module.exports = { packages: {
            'deep_import': {
              entryPoints: {
                './entry_point': { override: { typings: '../entry_point.d.ts', es2015: '../entry_point.js' } }
              }
            }
          }};`,
          },
          {
            name: _('/node_modules/deep_import/package.json'),
            contents: '{"name": "deep-import", "es2015": "./index.js", "typings": "./index.d.ts"}',
          },
          {
            name: _('/node_modules/deep_import/entry_point.js'),
            contents: `
              import {Component} from '@angular/core';
              @Component({selector: 'entry-point'})
              export class EntryPoint {}
            `,
          },
          {
            name: _('/node_modules/deep_import/entry_point.d.ts'),
            contents: `
              import {Component} from '@angular/core';
              @Component({selector: 'entry-point'})
              export class EntryPoint {}
            `,
          },
        ]);
        mainNgcc({
          basePath: '/node_modules',
          targetEntryPointPath: 'deep_import/entry_point',
          propertiesToConsider: ['es2015']
        });
        // The containing package is not processed
        expect(loadPackage('deep_import').__processed_by_ivy_ngcc__).toBeUndefined();
        // But the configured entry-point and its dependency (@angular/core) are processed.
        expect(loadPackage('deep_import/entry_point').__processed_by_ivy_ngcc__).toEqual({
          es2015: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        });
        expect(loadPackage('@angular/core').__processed_by_ivy_ngcc__).toEqual({
          es2015: '0.0.0-PLACEHOLDER',
          fesm2015: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        });
      });

      it('should not process ignored entry-points', () => {
        loadTestFiles([
          {
            name: _('/ngcc.config.js'),
            contents: `module.exports = { packages: {
            '@angular/core': {
              entryPoints: {
                './testing': {ignore: true}
              },
            },
            '@angular/common': {
              entryPoints: {
                '.': {ignore: true}
              },
            }
          }};`,
          },
        ]);
        mainNgcc({basePath: '/node_modules', propertiesToConsider: ['es2015']});
        // We process core but not core/testing.
        expect(loadPackage('@angular/core').__processed_by_ivy_ngcc__).toEqual({
          es2015: '0.0.0-PLACEHOLDER',
          fesm2015: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        });
        expect(loadPackage('@angular/core/testing').__processed_by_ivy_ngcc__).toBeUndefined();
        // We do not compile common but we do compile its sub-entry-points.
        expect(loadPackage('@angular/common').__processed_by_ivy_ngcc__).toBeUndefined();
        expect(loadPackage('@angular/common/http').__processed_by_ivy_ngcc__).toEqual({
          es2015: '0.0.0-PLACEHOLDER',
          fesm2015: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        });
      });

      it('should support removing a format property by setting it to `undefined`', () => {
        loadTestFiles([
          {
            name: _('/ngcc.config.js'),
            contents: `
              module.exports = {
                packages: {
                  'test-package': {
                    entryPoints: {
                      '.': {
                        override: {
                          fesm2015: undefined,
                        },
                      },
                    },
                  },
                },
              };
            `,
          },
          {
            name: _('/node_modules/test-package/package.json'),
            contents: `
              {
                "name": "test-package",
                "fesm2015": "./index.es2015.js",
                "fesm5": "./index.es5.js",
                "typings": "./index.d.ts"
              }
            `,
          },
          {
            name: _('/node_modules/test-package/index.es5.js'),
            contents: `
              var TestService = (function () {
                function TestService() {
                }
                return TestService;
              }());
            `,
          },
          {
            name: _('/node_modules/test-package/index.d.js'),
            contents: `
              export declare class TestService {}
            `,
          },
        ]);

        mainNgcc({
          basePath: '/node_modules',
          targetEntryPointPath: 'test-package',
          propertiesToConsider: ['fesm2015', 'fesm5'],
        });

        expect(loadPackage('test-package').__processed_by_ivy_ngcc__).toEqual({
          fesm5: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        });
      });
    });

    describe('undecorated child class migration', () => {
      it('should generate a directive definition with CopyDefinitionFeature for an undecorated child directive',
         () => {
           compileIntoFlatEs5Package('test-package', {
             '/index.ts': `
              import {Directive, NgModule} from '@angular/core';

              @Directive({
                selector: '[base]',
              })
              export class BaseDir {}

              export class DerivedDir extends BaseDir {}

              @NgModule({
                declarations: [DerivedDir],
              })
              export class Module {}
            `,
           });

           mainNgcc({
             basePath: '/node_modules',
             targetEntryPointPath: 'test-package',
             propertiesToConsider: ['main'],
           });


           const jsContents = fs.readFile(_(`/node_modules/test-package/index.js`));
           expect(jsContents)
               .toContain(
                   'DerivedDir.ɵdir = ɵngcc0.ɵɵdefineDirective({ type: DerivedDir, selectors: [["", "base", ""]], ' +
                   'features: [ɵngcc0.ɵɵInheritDefinitionFeature, ɵngcc0.ɵɵCopyDefinitionFeature] });');

           const dtsContents = fs.readFile(_(`/node_modules/test-package/index.d.ts`));
           expect(dtsContents)
               .toContain(
                   'static ɵdir: ɵngcc0.ɵɵDirectiveDefWithMeta<DerivedDir, "[base]", never, {}, {}, never>;');
         });

      it('should generate a component definition with CopyDefinitionFeature for an undecorated child component',
         () => {
           compileIntoFlatEs5Package('test-package', {
             '/index.ts': `
           import {Component, NgModule} from '@angular/core';

           @Component({
             selector: '[base]',
             template: '<span>This is the base template</span>',
           })
           export class BaseCmp {}

           export class DerivedCmp extends BaseCmp {}

           @NgModule({
             declarations: [DerivedCmp],
           })
           export class Module {}
         `,
           });

           mainNgcc({
             basePath: '/node_modules',
             targetEntryPointPath: 'test-package',
             propertiesToConsider: ['main'],
           });


           const jsContents = fs.readFile(_(`/node_modules/test-package/index.js`));
           expect(jsContents).toContain('DerivedCmp.ɵcmp = ɵngcc0.ɵɵdefineComponent');
           expect(jsContents)
               .toContain(
                   'features: [ɵngcc0.ɵɵInheritDefinitionFeature, ɵngcc0.ɵɵCopyDefinitionFeature]');

           const dtsContents = fs.readFile(_(`/node_modules/test-package/index.d.ts`));
           expect(dtsContents)
               .toContain(
                   'static ɵcmp: ɵngcc0.ɵɵComponentDefWithMeta<DerivedCmp, "[base]", never, {}, {}, never>;');
         });

      it('should generate directive definitions with CopyDefinitionFeature for undecorated child directives in a long inheritance chain',
         () => {
           compileIntoFlatEs5Package('test-package', {
             '/index.ts': `
           import {Directive, NgModule} from '@angular/core';

           @Directive({
             selector: '[base]',
           })
           export class BaseDir {}

           export class DerivedDir1 extends BaseDir {}

           export class DerivedDir2 extends DerivedDir1 {}

           export class DerivedDir3 extends DerivedDir2 {}

           @NgModule({
             declarations: [DerivedDir3],
           })
           export class Module {}
         `,
           });

           mainNgcc({
             basePath: '/node_modules',
             targetEntryPointPath: 'test-package',
             propertiesToConsider: ['main'],
           });

           const dtsContents = fs.readFile(_(`/node_modules/test-package/index.d.ts`));
           expect(dtsContents)
               .toContain(
                   'static ɵdir: ɵngcc0.ɵɵDirectiveDefWithMeta<DerivedDir1, "[base]", never, {}, {}, never>;');
           expect(dtsContents)
               .toContain(
                   'static ɵdir: ɵngcc0.ɵɵDirectiveDefWithMeta<DerivedDir2, "[base]", never, {}, {}, never>;');
           expect(dtsContents)
               .toContain(
                   'static ɵdir: ɵngcc0.ɵɵDirectiveDefWithMeta<DerivedDir3, "[base]", never, {}, {}, never>;');
         });
    });

    describe('aliasing re-exports in commonjs', () => {
      it('should add re-exports to commonjs files', () => {
        loadTestFiles([
          {
            name: _('/node_modules/test-package/package.json'),
            contents: `
              {
                "name": "test-package",
                "main": "./index.js",
                "typings": "./index.d.ts"
              }
            `,
          },
          {
            name: _('/node_modules/test-package/index.js'),
            contents: `
              var __export = null;
              __export(require("./module"));
            `,
          },
          {
            name: _('/node_modules/test-package/index.d.ts'),
            contents: `
              export * from "./module";
            `,
          },
          {
            name: _('/node_modules/test-package/index.metadata.json'),
            contents: '{}',
          },
          {
            name: _('/node_modules/test-package/module.js'),
            contents: `
              var __decorate = null;
              var core_1 = require("@angular/core");
              var directive_1 = require("./directive");
              var LocalDir = /** @class */ (function () {
                  function LocalDir() {
                  }
                  LocalDir = __decorate([
                      core_1.Directive({
                          selector: '[local]',
                      })
                  ], LocalDir);
                  return LocalDir;
              }());
              var FooModule = /** @class */ (function () {
                  function FooModule() {
                  }
                  FooModule = __decorate([
                      core_1.NgModule({
                          declarations: [directive_1.Foo, LocalDir],
                          exports: [directive_1.Foo, LocalDir],
                      })
                  ], FooModule);
                  return FooModule;
              }());
              exports.LocalDir = LocalDir;
              exports.FooModule = FooModule;
            `,
          },
          {
            name: _('/node_modules/test-package/module.d.ts'),
            contents: `
              export declare class LocalDir {}
              export declare class FooModule {}
            `,
          },
          {
            name: _('/node_modules/test-package/module.metadata.json'),
            contents: '{}',
          },
          {
            name: _('/node_modules/test-package/directive.js'),
            contents: `
              var __decorate = null;
              var core_1 = require("@angular/core");
              var Foo = /** @class */ (function () {
                  function Foo() {
                  }
                  Foo = __decorate([
                      core_1.Directive({
                          selector: '[foo]',
                      })
                  ], Foo);
                  return Foo;
              }());
              exports.Foo = Foo;
            `,
          },
          {
            name: _('/node_modules/test-package/directive.d.ts'),
            contents: `
              export declare class Foo {}
            `,
          },
          {
            name: _('/node_modules/test-package/directive.metadata.json'),
            contents: '{}',
          },
          {
            name: _('/ngcc.config.js'),
            contents: `
              module.exports = {
                packages: {
                  'test-package': {
                    entryPoints: {
                      '.': {
                        generateDeepReexports: true
                      },
                    },
                  },
                },
              };
            `,
          }
        ]);

        mainNgcc({
          basePath: '/node_modules',
          targetEntryPointPath: 'test-package',
          propertiesToConsider: ['main'],
        });

        expect(loadPackage('test-package').__processed_by_ivy_ngcc__).toEqual({
          main: '0.0.0-PLACEHOLDER',
          typings: '0.0.0-PLACEHOLDER',
        });

        const jsContents = fs.readFile(_(`/node_modules/test-package/module.js`));
        const dtsContents = fs.readFile(_(`/node_modules/test-package/module.d.ts`));
        expect(jsContents).toContain(`var ɵngcc1 = require('./directive');`);
        expect(jsContents).toContain('exports.ɵngExportɵFooModuleɵFoo = ɵngcc1.Foo;');
        expect(dtsContents)
            .toContain(`export {Foo as ɵngExportɵFooModuleɵFoo} from './directive';`);
        expect(dtsContents.match(/ɵngExportɵFooModuleɵFoo/g) !.length).toBe(1);
        expect(dtsContents).not.toContain(`ɵngExportɵFooModuleɵLocalDir`);
      });
    });

    function loadPackage(
        packageName: string, basePath: AbsoluteFsPath = _('/node_modules')): EntryPointPackageJson {
      return JSON.parse(fs.readFile(fs.resolve(basePath, packageName, 'package.json')));
    }

    function initMockFileSystem(fs: FileSystem, testFiles: Folder) {
      if (fs instanceof MockFileSystem) {
        fs.init(testFiles);
      }

      // a random test package that no metadata.json file so not compiled by Angular.
      loadTestFiles([
        {
          name: _('/node_modules/test-package/package.json'),
          contents: '{"name": "test-package", "es2015": "./index.js", "typings": "./index.d.ts"}'
        },
        {
          name: _('/node_modules/test-package/index.js'),
          contents:
              'import {AppModule} from "@angular/common"; export class MyApp extends AppModule {};'
        },
        {
          name: _('/node_modules/test-package/index.d.ts'),
          contents:
              'import {AppModule} from "@angular/common"; export declare class MyApp extends AppModule;'
        },
      ]);

      // An Angular package that has been built locally and stored in the `dist` directory.
      loadTestFiles([
        {
          name: _('/dist/local-package/package.json'),
          contents: '{"name": "local-package", "es2015": "./index.js", "typings": "./index.d.ts"}'
        },
        {name: _('/dist/local-package/index.metadata.json'), contents: 'DUMMY DATA'},
        {
          name: _('/dist/local-package/index.js'),
          contents:
              `import {Component} from '@angular/core';\nexport class AppComponent {};\nAppComponent.decorators = [\n{ type: Component, args: [{selector: 'app', template: '<h2>Hello</h2>'}] }\n];`
        },
        {
          name: _('/dist/local-package/index.d.ts'),
          contents: `export declare class AppComponent {};`
        },
      ]);

      // An Angular package that has a missing dependency
      loadTestFiles([
        {
          name: _('/node_modules/invalid-package/package.json'),
          contents: '{"name": "invalid-package", "es2015": "./index.js", "typings": "./index.d.ts"}'
        },
        {
          name: _('/node_modules/invalid-package/index.js'),
          contents: `
          import {AppModule} from "@angular/missing";
          import {Component} from '@angular/core';
          export class AppComponent {};
          AppComponent.decorators = [
            { type: Component, args: [{selector: 'app', template: '<h2>Hello</h2>'}] }
          ];
          `
        },
        {
          name: _('/node_modules/invalid-package/index.d.ts'),
          contents: `export declare class AppComponent {}`
        },
        {name: _('/node_modules/invalid-package/index.metadata.json'), contents: 'DUMMY DATA'},
      ]);
    }
  });
});

function countOccurrences(haystack: string, needle: string): number {
  const regex = new RegExp(needle, 'g');
  let count = 0;
  while (regex.exec(haystack)) {
    count++;
  }
  return count;
}
